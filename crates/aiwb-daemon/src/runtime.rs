//! 正在运行的 Agent 会话和它们的时间线。
//!
//! 适配器把归一化事件写进通道；这里给每条事件定 seq 和 rev，写进数据库，再推给订阅者。
//! 同一条流的覆盖沿用原来的 seq，换一个新的 rev。
//! 会话按需接上：第一次发送、要目录或权限菜单时才启动 CLI；daemon 重启后用 resume 接回原线程。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use aiwb_agents::{AgentAdapter, AgentError, AgentSession, SessionContext, TurnDelivery, UserTurn};
use aiwb_core::attention::{self, Attention};
use aiwb_core::models::{
    new_id, AgentCatalog, now_millis, AgentKind, PageAnnotation, QueuedTurn, SessionEvent, SessionEventBody,
    SessionStatus,
};
use aiwb_core::rpc::{session_topic, TOPIC_TASKS};
use aiwb_core::task::{SessionFeed, SessionOptions, StoredEvent, TaskWorkspace};
use aiwb_core::timeline::{is_conversation_activity, merge_into, title_from_user_message};
use aiwb_store::Store;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::hub::Hub;

mod handoff;

pub type AdapterFactory = Arc<dyn Fn(AgentKind) -> Arc<dyn AgentAdapter> + Send + Sync>;

pub(crate) type RuntimeResult<T> = Result<T, String>;

/// 这次 daemon 运行期间碰过的会话的时间线。数据库仍是唯一来源，这份只为了归并流式覆盖。
struct Log {
    task_id: String,
    /// 侧边聊天：不改任务的更新时间和标题。
    side: bool,
    events: Vec<SessionEvent>,
    next_seq: u64,
    next_rev: u64,
    queue: Vec<QueuedTurn>,
}

/// 接上的 CLI。`muted` 置上后它报的事件不再进时间线；`used_at` 是最后一次用到它或它报事件的时间。
struct Live {
    handle: Arc<dyn AgentSession>,
    muted: Arc<AtomicBool>,
    used_at: Arc<AtomicI64>,
}

pub struct Runtimes {
    store: Arc<Store>,
    hub: Arc<Hub>,
    adapters: AdapterFactory,
    logs: Mutex<HashMap<String, Log>>,
    live: Mutex<HashMap<String, Live>>,
    /// 同一时间只打开一个会话，避免对同一线程起两个 CLI。
    opening: tokio::sync::Mutex<()>,
    /// 同一时间只探一次目录。等锁的一方拿到锁后先看缓存。
    pub(crate) probing: tokio::sync::Mutex<()>,
    /// 这次启动后拿到过新目录的 Agent。没拿到过的，存下的目录可能是旧的。
    pub(crate) fresh_catalogs: Mutex<HashSet<AgentKind>>,
    /// 每条连接正看着的任务。窗口没有焦点时界面会报空。
    viewing: Mutex<HashMap<u64, String>>,
    /// 每条连接的面板里开着侧边聊天标签的任务。有标签就不空闲回收。
    side_tabs: Mutex<HashMap<u64, HashSet<String>>>,
}

impl Runtimes {
    pub fn new(store: Arc<Store>, hub: Arc<Hub>, adapters: AdapterFactory) -> Self {
        Self {
            store,
            hub,
            adapters,
            logs: Mutex::default(),
            live: Mutex::default(),
            opening: tokio::sync::Mutex::new(()),
            probing: tokio::sync::Mutex::new(()),
            fresh_catalogs: Mutex::default(),
            viewing: Mutex::default(),
            side_tabs: Mutex::default(),
        }
    }

    pub(crate) fn adapter(&self, agent: AgentKind) -> Arc<dyn AgentAdapter> {
        (self.adapters)(agent)
    }

    /// 上次退出时还在跑或在等输入的会话，那一轮已经断了。记一条停止状态。
    pub(crate) fn settle_interrupted(&self) -> RuntimeResult<()> {
        let sessions = self.store.list_sessions().map_err(|e| e.to_string())?;
        for session in sessions {
            if matches!(session.status, SessionStatus::Running | SessionStatus::NeedsInput) {
                self.record(
                    &session.id,
                    SessionEventBody::StatusChanged {
                        status: SessionStatus::Stopped,
                    },
                )?;
            }
        }
        Ok(())
    }

    /// 一条连接报它正看着哪个任务（空表示没在看）。看着的任务清掉未读。
    pub(crate) fn set_viewing(&self, connection: u64, task_id: Option<String>) -> RuntimeResult<()> {
        {
            let mut viewing = self.viewing.lock().unwrap();
            match &task_id {
                Some(id) => viewing.insert(connection, id.clone()),
                None => viewing.remove(&connection),
            };
        }
        let Some(task_id) = task_id else {
            return Ok(());
        };
        let store_err = |e: aiwb_store::StoreError| e.to_string();
        let Some(current) = self.store.task_sessions(&task_id).map_err(store_err)?.pop() else {
            return Ok(());
        };
        if self.store.mark_read(&current.id).map_err(store_err)? {
            self.publish_tasks()?;
        }
        Ok(())
    }

    fn is_viewed(&self, task_id: &str) -> bool {
        self.viewing.lock().unwrap().values().any(|id| id == task_id)
    }

    /// 一条连接报它的面板里哪些任务开着侧边聊天标签。连接断开时报空。
    pub(crate) fn set_side_tabs(&self, connection: u64, task_ids: Vec<String>) {
        let mut tabs = self.side_tabs.lock().unwrap();
        if task_ids.is_empty() {
            tabs.remove(&connection);
        } else {
            tabs.insert(connection, task_ids.into_iter().collect());
        }
    }

    fn has_side_tab(&self, task_id: &str) -> bool {
        self.side_tabs.lock().unwrap().values().any(|ids| ids.contains(task_id))
    }

    /// 这条事件之后的注意力。状态变了按有没有人在看记未读；在等输入时来了新提问换掉预览。
    fn next_attention(
        &self,
        session_id: &str,
        task_id: &str,
        body: &SessionEventBody,
        events: &[SessionEvent],
        now: i64,
    ) -> RuntimeResult<Option<Attention>> {
        let prev = || -> RuntimeResult<Attention> {
            Ok(self
                .store
                .attention(session_id)
                .map_err(|e| e.to_string())?
                .unwrap_or_else(|| Attention::from_status(SessionStatus::Stopped, now)))
        };
        Ok(match body {
            SessionEventBody::StatusChanged { status } => {
                attention::on_status(&prev()?, *status, events, self.is_viewed(task_id), now)
            }
            SessionEventBody::Prompt { .. } | SessionEventBody::PromptResolved { .. } => {
                attention::on_prompt(&prev()?, events)
            }
            _ => None,
        })
    }

    pub(crate) fn publish_tasks(&self) -> RuntimeResult<()> {
        self.hub.publish_with(TOPIC_TASKS, || {
            let entries = self.store.task_entries().map_err(|e| e.to_string())?;
            Ok(((), serde_json::to_value(entries).map_err(|e| e.to_string())?))
        })
    }

    /// `session:<id>` 的快照：rev 大于 `from_rev` 的事件和当前排队。
    pub(crate) fn snapshot(&self, session_id: &str, from_rev: u64) -> RuntimeResult<Value> {
        if self.store.session(session_id).map_err(|e| e.to_string())?.is_none() {
            return Err("会话不存在".into());
        }
        let events = self
            .store
            .events_since(session_id, from_rev)
            .map_err(|e| e.to_string())?;
        let queue = self
            .logs
            .lock()
            .unwrap()
            .get(session_id)
            .map(|log| log.queue.clone())
            .unwrap_or_default();
        let feed = SessionFeed {
            reset: from_rev == 0,
            events,
            queue: Some(queue),
        };
        serde_json::to_value(feed).map_err(|e| e.to_string())
    }

    /// 把一条事件体并进时间线、写库、推送。状态和标题变了再推一次任务列表。
    pub(crate) fn record(&self, session_id: &str, body: SessionEventBody) -> RuntimeResult<()> {
        let topic = session_topic(session_id);
        match body {
            // 适配器请求宿主另开会话。任务里还没有这个入口，不进时间线。
            SessionEventBody::NewThread { .. } => Ok(()),
            SessionEventBody::QueueChanged { items } => self.hub.publish_with(&topic, || {
                let mut logs = self.logs.lock().unwrap();
                let log = self.log_mut(&mut logs, session_id)?;
                log.queue = items.clone();
                let feed = SessionFeed {
                    queue: Some(items),
                    ..Default::default()
                };
                Ok(((), serde_json::to_value(feed).map_err(|e| e.to_string())?))
            }),
            body => {
                if let SessionEventBody::CollaborationMode { mode } = &body {
                    self.keep_collaboration_mode(session_id, mode)?;
                }
                let status = matches!(body, SessionEventBody::StatusChanged { .. });
                let title = match &body {
                    SessionEventBody::UserMessage {
                        text,
                        images,
                        annotations,
                    } => title_from_user_message(text, images.len(), *annotations),
                    _ => None,
                };
                let activity = is_conversation_activity(&body);
                let (task_id, side, attention_changed) = self.append_at(session_id, body, activity, now_millis())?;
                let titled = match title {
                    Some(title) if !side => self.adopt_title(&task_id, &title)?,
                    _ => false,
                };
                if status || attention_changed || titled {
                    self.publish_tasks()?;
                }
                Ok(())
            }
        }
    }

    /// 并进时间线、写库、推给订阅者，返回任务 id、是不是侧边聊天、注意力有没有变。
    /// `activity` 时把任务的更新时间挪到 `now`，侧边聊天不挪。
    /// 状态事件的注意力和事件写在同一个事务里。分叉复制时间线时沿用原来的时间，回合用时才对得上。
    fn append_at(
        &self,
        session_id: &str,
        body: SessionEventBody,
        activity: bool,
        now: i64,
    ) -> RuntimeResult<(String, bool, bool)> {
        let topic = session_topic(session_id);
        self.hub.publish_with(&topic, || -> RuntimeResult<_> {
            let mut logs = self.logs.lock().unwrap();
            let log = self.log_mut(&mut logs, session_id)?;
            let event = match merge_into(&mut log.events, &body, now) {
                Some(index) => log.events[index].clone(),
                None => {
                    let event = SessionEvent {
                        id: new_id(),
                        session_id: session_id.to_string(),
                        seq: log.next_seq,
                        ts: now,
                        body,
                    };
                    log.next_seq += 1;
                    log.events.push(event.clone());
                    event
                }
            };
            let attention = self.next_attention(session_id, &log.task_id, &event.body, &log.events, now)?;
            let stored = StoredEvent {
                event,
                rev: log.next_rev,
            };
            log.next_rev += 1;
            self.store
                .put_event(&log.task_id, &stored, activity && !log.side, attention.as_ref())
                .map_err(|e| e.to_string())?;
            let feed = SessionFeed {
                events: vec![stored],
                ..Default::default()
            };
            let data = serde_json::to_value(feed).map_err(|e| e.to_string())?;
            Ok(((log.task_id.clone(), log.side, attention.is_some()), data))
        })
    }

    /// 改写时间线里已有的一条：沿用 seq，换新的 rev。
    fn rewrite(&self, session_id: &str, event_id: &str, body: SessionEventBody) -> RuntimeResult<()> {
        let topic = session_topic(session_id);
        self.hub.publish_with(&topic, || -> RuntimeResult<_> {
            let mut logs = self.logs.lock().unwrap();
            let log = self.log_mut(&mut logs, session_id)?;
            let event = log
                .events
                .iter_mut()
                .find(|event| event.id == event_id)
                .ok_or_else(|| "时间线里没有这条事件".to_string())?;
            event.body = body;
            let stored = StoredEvent {
                event: event.clone(),
                rev: log.next_rev,
            };
            log.next_rev += 1;
            self.store
                .put_event(&log.task_id, &stored, false, None)
                .map_err(|e| e.to_string())?;
            let feed = SessionFeed {
                events: vec![stored],
                ..Default::default()
            };
            Ok(((), serde_json::to_value(feed).map_err(|e| e.to_string())?))
        })
    }

    /// 会话删掉之前：停掉 CLI，丢掉这里的时间线副本。
    pub(crate) async fn discard(&self, session_id: &str) {
        self.stop(session_id).await;
        self.logs.lock().unwrap().remove(session_id);
    }

    /// 关掉侧边聊天：停进程，删会话、时间线和没发的草稿。
    /// 等正在接的 CLI 接完再关，免得刚分出来的进程没人管。
    pub(crate) async fn discard_side(&self, session_id: &str) -> RuntimeResult<()> {
        let _opening = self.opening.lock().await;
        self.remove_side(session_id).await
    }

    /// 调用方拿着 `opening`。
    async fn remove_side(&self, session_id: &str) -> RuntimeResult<()> {
        let entry = self.live.lock().unwrap().remove(session_id);
        if let Some(entry) = entry {
            entry.muted.store(true, Ordering::SeqCst);
            let _ = entry.handle.stop().await;
        }
        self.logs.lock().unwrap().remove(session_id);
        let store_err = |e: aiwb_store::StoreError| e.to_string();
        self.store.remove_session(session_id).map_err(store_err)?;
        self.store.set_draft(session_id, None, now_millis()).map_err(store_err)?;
        self.publish_tasks()
    }

    /// 导入的历史：按原来的顺序写进时间线。不动任务的更新时间和标题，状态留在已完成。
    pub(crate) fn import_events(&self, session_id: &str, history: Vec<SessionEventBody>) -> RuntimeResult<()> {
        for body in history {
            if matches!(
                body,
                SessionEventBody::StatusChanged { .. }
                    | SessionEventBody::QueueChanged { .. }
                    | SessionEventBody::NewThread { .. }
            ) {
                continue;
            }
            self.append_at(session_id, body, false, now_millis())?;
        }
        Ok(())
    }

    /// Agent 自己切了计划模式（比如批准退出计划）。记进会话选项，重新接上时不再切回去。
    fn keep_collaboration_mode(&self, session_id: &str, mode: &str) -> RuntimeResult<()> {
        let Some(session) = self.store.session(session_id).map_err(|e| e.to_string())? else {
            return Ok(());
        };
        let mode = (mode == "plan").then(|| "plan".to_string());
        if session.options.collaboration_mode == mode {
            return Ok(());
        }
        let options = SessionOptions {
            collaboration_mode: mode,
            ..session.options
        };
        self.store
            .set_session_options(session_id, &options)
            .map_err(|e| e.to_string())
    }

    /// 任务还没有标题时，用第一条用户消息。
    fn adopt_title(&self, task_id: &str, title: &str) -> RuntimeResult<bool> {
        let task = self.store.task(task_id).map_err(|e| e.to_string())?;
        if task.is_none_or(|task| !task.title.trim().is_empty()) {
            return Ok(false);
        }
        self.store
            .set_task_title(task_id, title, now_millis())
            .map_err(|e| e.to_string())
    }

    fn log_mut<'a>(
        &self,
        logs: &'a mut HashMap<String, Log>,
        session_id: &str,
    ) -> RuntimeResult<&'a mut Log> {
        if !logs.contains_key(session_id) {
            let session = self
                .store
                .session(session_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "会话不存在".to_string())?;
            let stored = self
                .store
                .events_since(session_id, 0)
                .map_err(|e| e.to_string())?;
            let next_seq = stored.iter().map(|item| item.event.seq).max().unwrap_or(0) + 1;
            let next_rev = stored.iter().map(|item| item.rev).max().unwrap_or(0) + 1;
            let side = self
                .store
                .is_side_session(session_id)
                .map_err(|e| e.to_string())?;
            logs.insert(
                session_id.to_string(),
                Log {
                    task_id: session.task_id,
                    side,
                    events: stored.into_iter().map(|item| item.event).collect(),
                    next_seq,
                    next_rev,
                    queue: Vec::new(),
                },
            );
        }
        Ok(logs.get_mut(session_id).expect("log just inserted"))
    }

    /// 会话干活的目录：工作树任务是检出目录，独立聊天是它自己的文件夹，否则是项目主目录。
    pub(crate) fn workdir(&self, session_id: &str) -> RuntimeResult<String> {
        let session = self
            .store
            .session(session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "会话不存在".to_string())?;
        self.workdir_of_task(&session.task_id)
    }

    fn workdir_of_task(&self, task_id: &str) -> RuntimeResult<String> {
        let store_err = |e: aiwb_store::StoreError| e.to_string();
        let task = self
            .store
            .task(task_id)
            .map_err(store_err)?
            .ok_or_else(|| "任务不存在".to_string())?;
        Ok(match task.workspace {
            TaskWorkspace::Worktree { path, .. } | TaskWorkspace::Folder { path } => path,
            TaskWorkspace::Root => {
                let project_id = task.project_id.ok_or_else(|| "项目不存在".to_string())?;
                self.store
                    .project(&project_id)
                    .map_err(store_err)?
                    .ok_or_else(|| "项目不存在".to_string())?
                    .path
            }
        })
    }

    pub(crate) fn live_handle(&self, session_id: &str) -> Option<Arc<dyn AgentSession>> {
        let live = self.live.lock().unwrap();
        let entry = live.get(session_id)?;
        entry.used_at.store(now_millis(), Ordering::SeqCst);
        Some(entry.handle.clone())
    }

    /// 已接上的句柄；没有就启动 CLI。有原生 id 时 resume，不重放历史。
    pub(crate) async fn ensure_live(
        self: &Arc<Self>,
        session_id: &str,
    ) -> RuntimeResult<Arc<dyn AgentSession>> {
        if let Some(handle) = self.live_handle(session_id) {
            return Ok(handle);
        }
        let _opening = self.opening.lock().await;
        if let Some(handle) = self.live_handle(session_id) {
            return Ok(handle);
        }
        let store_err = |e: aiwb_store::StoreError| e.to_string();
        let session = self
            .store
            .session(session_id)
            .map_err(store_err)?
            .ok_or_else(|| "会话不存在".to_string())?;
        let cwd = self.workdir_of_task(&session.task_id)?;
        let side_of = if self.store.is_side_session(session_id).map_err(store_err)? {
            Some(self.side_parent(&session)?)
        } else {
            None
        };
        let resume = session.native_id.clone().filter(|id| !id.is_empty());
        let mut options = match &side_of {
            Some(parent) => json!({ "persist": false, "side_of": parent }),
            None => json!({ "persist": true, "skip_history": resume.is_some() }),
        };
        if let Some(access) = session.options.access.as_ref() {
            if !access.writable_roots.is_empty() {
                options["writable_roots"] = json!(access.writable_roots);
            }
        }
        let ctx = SessionContext {
            project_path: cwd,
            access_mode: session.options.access.as_ref().map(|access| access.mode.clone()),
            options,
            resume_native_id: if side_of.is_some() { None } else { resume },
        };
        let (tx, rx) = mpsc::unbounded_channel();
        let muted = Arc::new(AtomicBool::new(false));
        let used_at = Arc::new(AtomicI64::new(now_millis()));
        self.spawn_pump(session_id.to_string(), rx, muted.clone(), used_at.clone());
        let handle = match self.adapter(session.agent).start_session(ctx, tx).await {
            Ok(handle) => handle,
            Err(err) => {
                let message = err.to_string();
                self.record(session_id, SessionEventBody::Error { message: message.clone() })?;
                self.record(
                    session_id,
                    SessionEventBody::StatusChanged {
                        status: SessionStatus::Failed,
                    },
                )?;
                return Err(message);
            }
        };
        // 适配器换了原生会话（例如 Cursor 没发过消息的空会话不能载入，只能新开）时跟着改。
        if let Some(native) = handle.native_id().filter(|id| !id.is_empty()) {
            if session.native_id.as_deref() != Some(native.as_str()) {
                self.store
                    .set_session_native_id(session_id, &native)
                    .map_err(store_err)?;
            }
        }
        apply_options(handle.as_ref(), &session.options).await;
        self.live.lock().unwrap().insert(
            session_id.to_string(),
            Live {
                handle: handle.clone(),
                muted,
                used_at,
            },
        );
        Ok(handle)
    }

    /// 侧边聊天从任务现在这段的原生会话分出来。分出来的会话不落盘，CLI 退出后接不回去。
    fn side_parent(&self, side: &aiwb_core::task::TaskSession) -> RuntimeResult<String> {
        if side.native_id.as_deref().is_some_and(|id| !id.is_empty()) {
            return Err("侧边聊天已断开，关掉后重新打开".into());
        }
        self.store
            .task_sessions(&side.task_id)
            .map_err(|e| e.to_string())?
            .pop()
            .and_then(|current| current.native_id)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "主对话发出第一条消息后才能开侧边聊天".to_string())
    }

    fn spawn_pump(
        self: &Arc<Self>,
        session_id: String,
        mut rx: mpsc::UnboundedReceiver<SessionEventBody>,
        muted: Arc<AtomicBool>,
        used_at: Arc<AtomicI64>,
    ) {
        let runtimes = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(body) = rx.recv().await {
                if muted.load(Ordering::SeqCst) {
                    continue;
                }
                used_at.store(now_millis(), Ordering::SeqCst);
                if let Err(err) = runtimes.record(&session_id, body) {
                    eprintln!("记录会话 {session_id} 的事件失败：{err}");
                }
            }
        });
    }

    /// 进程已经退出的句柄扔掉，下次用到时重新接上。
    fn forget(&self, session_id: &str) {
        self.live.lock().unwrap().remove(session_id);
    }

    /// 跑一个要句柄的操作。CLI 已经退出时重新接上再试一次。
    async fn with_handle<T, F, Fut>(self: &Arc<Self>, session_id: &str, work: F) -> RuntimeResult<T>
    where
        F: Fn(Arc<dyn AgentSession>) -> Fut,
        Fut: std::future::Future<Output = Result<T, AgentError>>,
    {
        let handle = self.ensure_live(session_id).await?;
        match work(handle).await {
            Err(AgentError::Closed) => {
                self.forget(session_id);
                let handle = self.ensure_live(session_id).await?;
                work(handle).await.map_err(|e| e.to_string())
            }
            other => other.map_err(|e| e.to_string()),
        }
    }

    /// 发一条用户消息。斜杠命令不画用户气泡；排队的消息等真正发出时由适配器记。
    pub(crate) async fn send(
        self: &Arc<Self>,
        session_id: &str,
        text: String,
        images: Vec<String>,
        now: bool,
    ) -> RuntimeResult<TurnDelivery> {
        if text.trim().is_empty() && images.is_empty() {
            return Err("消息不能为空".into());
        }
        let handle = self.ensure_live(session_id).await?;
        if handle.read_only() {
            return Err("此会话正被其他进程占用，当前只读，不能发送。".into());
        }
        if text.starts_with('/') && images.is_empty() {
            let text = text.clone();
            self.with_handle(session_id, move |handle| {
                let text = text.clone();
                async move { handle.send_message(text).await }
            })
            .await?;
            return Ok(TurnDelivery::Started);
        }
        // 换 Agent 后的第一条消息带上前文。时间线里的用户气泡仍只画用户写的。
        let handoff = self.prepare_handoff(session_id, &text, images.len())?;
        let turn = UserTurn {
            text: handoff.as_ref().map_or_else(|| text.clone(), |handoff| handoff.message(&text)),
            images: images.clone(),
            client_id: new_id(),
            annotations: Vec::new(),
        };
        let delivery = self
            .with_handle(session_id, move |handle| {
                let turn = turn.clone();
                async move {
                    if now {
                        handle.deliver_now(turn).await
                    } else {
                        handle.deliver(turn).await
                    }
                }
            })
            .await?;
        if let Some(handoff) = handoff {
            self.mark_delivered(session_id, handoff)?;
        }
        if delivery == TurnDelivery::Started {
            self.record(
                session_id,
                SessionEventBody::UserMessage {
                    text,
                    images,
                    annotations: 0,
                },
            )?;
        }
        Ok(delivery)
    }

    /// 页面批注：评论当正文，截图当附图。
    pub(crate) async fn submit_annotation(
        self: &Arc<Self>,
        session_id: &str,
        note: PageAnnotation,
    ) -> RuntimeResult<TurnDelivery> {
        let handle = self.ensure_live(session_id).await?;
        if handle.read_only() {
            return Err("此会话正被其他进程占用，当前只读，不能发送。".into());
        }
        let comment = note.comment.trim().to_string();
        let images: Vec<String> = note
            .screenshot
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_string)
            .into_iter()
            .collect();
        let delivery = self
            .with_handle(session_id, move |handle| {
                let note = note.clone();
                async move { handle.submit_annotation(note).await }
            })
            .await?;
        if delivery == TurnDelivery::Started {
            self.record(
                session_id,
                SessionEventBody::UserMessage {
                    text: comment,
                    images,
                    annotations: 1,
                },
            )?;
        }
        Ok(delivery)
    }

    /// 设目标，时间线里记一条 `/goal …` 的用户消息：Agent 接着干的那一轮有个来由。
    /// 照 t3code `apps/web/src/components/chat/useThreadLifecycle.tsx` 的 `sendStandaloneCommand`。
    /// 只有目标的新任务用目标当标题，不用带斜杠的命令。
    pub(crate) async fn set_goal(self: &Arc<Self>, session_id: &str, objective: &str) -> RuntimeResult<()> {
        let objective = objective.trim().to_string();
        if objective.is_empty() {
            return Err("目标不能为空".into());
        }
        let handle = self.ensure_live(session_id).await?;
        if handle.read_only() {
            return Err("此会话正被其他进程占用，当前只读，不能发送。".into());
        }
        handle.set_goal(&objective).await.map_err(|e| e.to_string())?;
        let session = self
            .store
            .session(session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "会话不存在".to_string())?;
        let side = self.store.is_side_session(session_id).map_err(|e| e.to_string())?;
        if let Some(title) = title_from_user_message(&objective, 0, 0).filter(|_| !side) {
            if self.adopt_title(&session.task_id, &title)? {
                self.publish_tasks()?;
            }
        }
        self.record(
            session_id,
            SessionEventBody::UserMessage {
                text: format!("/goal {objective}"),
                images: Vec::new(),
                annotations: 0,
            },
        )
    }

    pub(crate) async fn interrupt(self: &Arc<Self>, session_id: &str) -> RuntimeResult<()> {
        // 没接上的会话没有在跑的回合。
        let Some(handle) = self.live_handle(session_id) else {
            return Ok(());
        };
        handle.interrupt().await.map_err(|e| e.to_string())
    }

    pub(crate) async fn handle(self: &Arc<Self>, session_id: &str) -> RuntimeResult<Arc<dyn AgentSession>> {
        self.ensure_live(session_id).await
    }

    /// 改后续回合的选项：写库，已接上的会话立刻生效。
    pub(crate) async fn set_options(&self, session_id: &str, options: &SessionOptions) -> RuntimeResult<()> {
        self.store
            .set_session_options(session_id, options)
            .map_err(|e| e.to_string())?;
        if let Some(handle) = self.live_handle(session_id) {
            apply_options(handle.as_ref(), options).await;
        }
        self.publish_tasks()
    }

    pub(crate) async fn stop(&self, session_id: &str) {
        let entry = self.live.lock().unwrap().remove(session_id);
        if let Some(entry) = entry {
            let _ = entry.handle.stop().await;
        }
    }

    /// 已完成、空闲超过 `idle_ms`、没人在看、没有排队、能 resume 的会话：关掉 CLI，丢掉时间线副本。
    /// 关之前先静音，适配器关进程时报的状态不进时间线，会话仍是已完成。下次用到时 `ensure_live` 接回。
    /// 侧边聊天接不回去：哪条连接的面板里都没有它的标签时，已完成、空闲、没有排队就直接关掉
    /// （界面关了或重载后标签没了）。有标签时窗口没焦点、在看别的任务也留着。
    pub(crate) async fn release_idle(&self, now: i64, idle_ms: i64) -> RuntimeResult<usize> {
        let _opening = self.opening.lock().await;
        let idle = |entry: &Live| now - entry.used_at.load(Ordering::SeqCst) >= idle_ms;
        let candidates: Vec<String> = self
            .live
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, entry)| idle(entry))
            .map(|(id, _)| id.clone())
            .collect();
        let mut released = 0;
        for session_id in candidates {
            let Some(session) = self.store.session(&session_id).map_err(|e| e.to_string())? else {
                continue;
            };
            if session.status != SessionStatus::Completed {
                continue;
            }
            if self.store.is_side_session(&session_id).map_err(|e| e.to_string())? {
                if self.has_side_tab(&session.task_id) {
                    continue;
                }
                let queued = self
                    .logs
                    .lock()
                    .unwrap()
                    .get(&session_id)
                    .is_some_and(|log| !log.queue.is_empty());
                if !queued {
                    self.remove_side(&session_id).await?;
                    released += 1;
                }
                continue;
            }
            let resumable = session.native_id.as_deref().is_some_and(|id| !id.is_empty());
            if !resumable || self.is_viewed(&session.task_id) {
                continue;
            }
            let entry = {
                let mut logs = self.logs.lock().unwrap();
                if logs.get(&session_id).is_some_and(|log| !log.queue.is_empty()) {
                    continue;
                }
                let mut live = self.live.lock().unwrap();
                match live.get(&session_id) {
                    Some(entry) if idle(entry) && !entry.handle.read_only() => {}
                    _ => continue,
                }
                let entry = live.remove(&session_id).expect("entry just checked");
                entry.muted.store(true, Ordering::SeqCst);
                logs.remove(&session_id);
                entry
            };
            let _ = entry.handle.stop().await;
            released += 1;
        }
        Ok(released)
    }

    /// 不建线程起一次 CLI，只要模型目录，拿到就关掉。
    pub(crate) async fn probe_catalog(&self, agent: AgentKind, cwd: String) -> RuntimeResult<AgentCatalog> {
        let ctx = SessionContext {
            project_path: cwd,
            access_mode: None,
            resume_native_id: None,
            options: json!({}),
        };
        let (tx, _rx) = mpsc::unbounded_channel();
        let handle = self
            .adapter(agent)
            .start_session(ctx, tx)
            .await
            .map_err(|e| e.to_string())?;
        let catalog = handle.catalog().await.map_err(|e| e.to_string());
        let _ = handle.stop().await;
        catalog
    }

    pub(crate) async fn stop_all(&self) {
        let handles: Vec<_> = self.live.lock().unwrap().drain().map(|(_, entry)| entry.handle).collect();
        for handle in handles {
            let _ = handle.stop().await;
        }
    }

    pub(crate) fn is_live(&self, session_id: &str) -> bool {
        self.live.lock().unwrap().contains_key(session_id)
    }
}

/// 选项写给句柄。不支持的项由适配器自己忽略或拒绝；拒绝不挡发送。
/// 模型和强度为空时清掉覆盖，回到 CLI 配置；速度档没选过就不碰，让 CLI 配置生效。
async fn apply_options(handle: &dyn AgentSession, options: &SessionOptions) {
    let _ = handle.set_tuning(
        Some(options.model.clone().unwrap_or_default()),
        Some(options.effort.clone().unwrap_or_default()),
    );
    if let Some(tier) = options.service_tier.clone() {
        let _ = handle.set_service_tier(Some(tier));
    }
    if let Some(access) = options.access.as_ref() {
        let _ = handle.set_sandbox(
            &access.mode,
            access.network_access,
            &access.writable_roots,
            &access.profile_id,
        );
    }
    if let Some(mode) = options.collaboration_mode.as_deref() {
        let _ = handle.set_collaboration_mode(mode);
    }
    if let Some(mode) = options.follow_up_queue_mode.as_deref() {
        let _ = handle.set_follow_up_queue_mode(mode).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiwb_core::task::{Task, TaskSession};

    fn runtimes_with_task(status: SessionStatus) -> (Arc<Store>, Runtimes) {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let task = Task {
            id: "t".into(),
            project_id: None,
            title: String::new(),
            workspace: TaskWorkspace::Folder { path: "x".into() },
            pinned: false,
            archived_at: None,
            created_at: 1,
            updated_at: 1,
        };
        let session = TaskSession {
            id: "s".into(),
            task_id: "t".into(),
            agent: AgentKind::ClaudeCode,
            native_id: None,
            status,
            options: SessionOptions::default(),
            created_at: 1,
            updated_at: 1,
        };
        store.insert_task(&task, &session).unwrap();
        let runtimes = Runtimes::new(store.clone(), Arc::new(Hub::new()), Arc::new(aiwb_agents::adapter_for));
        (store, runtimes)
    }

    fn status(status: SessionStatus) -> SessionEventBody {
        SessionEventBody::StatusChanged { status }
    }

    #[test]
    fn finishing_while_nobody_looks_is_unread_until_viewed() {
        use aiwb_core::attention::AttentionState;
        let (store, runtimes) = runtimes_with_task(SessionStatus::Completed);
        runtimes.record("s", status(SessionStatus::Running)).unwrap();
        runtimes
            .record(
                "s",
                SessionEventBody::AgentMessage {
                    text: "改完了".into(),
                    stream_id: None,
                    phase: None,
                    mode: None,
                    dedupe_of: None,
                },
            )
            .unwrap();
        runtimes.record("s", status(SessionStatus::Completed)).unwrap();
        let done = store.attention("s").unwrap().unwrap();
        assert_eq!(done.state, AttentionState::Done);
        assert!(done.unread);
        assert_eq!(done.preview.as_deref(), Some("改完了"));

        // 看一眼清掉；看着的时候再跑完不记未读。
        runtimes.set_viewing(7, Some("t".into())).unwrap();
        assert!(!store.attention("s").unwrap().unwrap().unread);
        runtimes.record("s", status(SessionStatus::Running)).unwrap();
        runtimes.record("s", status(SessionStatus::Completed)).unwrap();
        assert!(!store.attention("s").unwrap().unwrap().unread);

        // 走开了（窗口失焦、连接断开）再跑完，又记上。
        runtimes.set_viewing(7, None).unwrap();
        runtimes.record("s", status(SessionStatus::Running)).unwrap();
        runtimes.record("s", status(SessionStatus::Failed)).unwrap();
        let failed = store.attention("s").unwrap().unwrap();
        assert_eq!(failed.state, AttentionState::Failed);
        assert!(failed.unread);
    }

    /// 关进程时像 Codex 一样报「已停止」的假会话。
    struct QuietlyStopped {
        sink: mpsc::UnboundedSender<SessionEventBody>,
        stopped: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl aiwb_agents::DiffScopeProvider for QuietlyStopped {}

    #[async_trait::async_trait]
    impl aiwb_agents::AnnotationSink for QuietlyStopped {
        async fn submit_annotation(&self, _note: PageAnnotation) -> Result<TurnDelivery, AgentError> {
            Ok(TurnDelivery::Started)
        }
    }

    #[async_trait::async_trait]
    impl AgentSession for QuietlyStopped {
        async fn send_message(&self, _text: String) -> Result<(), AgentError> {
            Ok(())
        }

        async fn answer_prompt(&self, _id: &str, _answer: aiwb_core::models::PromptAnswer) -> Result<(), AgentError> {
            Ok(())
        }

        async fn stop(&self) -> Result<(), AgentError> {
            self.stopped.fetch_add(1, Ordering::SeqCst);
            let _ = self.sink.send(status(SessionStatus::Stopped));
            Ok(())
        }
    }

    /// 像 `ensure_live` 一样接上一个假会话，最后一次用到是 `used_at`。
    fn attach(runtimes: &Arc<Runtimes>, used_at: i64) -> Arc<QuietlyStopped> {
        let (tx, rx) = mpsc::unbounded_channel();
        let muted = Arc::new(AtomicBool::new(false));
        let used = Arc::new(AtomicI64::new(used_at));
        runtimes.spawn_pump("s".into(), rx, muted.clone(), used.clone());
        let session = Arc::new(QuietlyStopped {
            sink: tx,
            stopped: Default::default(),
        });
        runtimes.live.lock().unwrap().insert(
            "s".into(),
            Live {
                handle: session.clone(),
                muted,
                used_at: used,
            },
        );
        session
    }

    fn resumable_runtimes() -> (Arc<Store>, Arc<Runtimes>) {
        let (store, runtimes) = runtimes_with_task(SessionStatus::Completed);
        store.set_session_native_id("s", "thread-1").unwrap();
        (store, Arc::new(runtimes))
    }

    const MIN: i64 = 60_000;

    #[tokio::test]
    async fn idle_completed_session_is_released_without_changing_its_status() {
        let (store, runtimes) = resumable_runtimes();
        let session = attach(&runtimes, 0);
        assert_eq!(runtimes.release_idle(30 * MIN, 30 * MIN).await.unwrap(), 1);
        assert_eq!(session.stopped.load(Ordering::SeqCst), 1);
        assert!(!runtimes.is_live("s"));
        assert!(!runtimes.logs.lock().unwrap().contains_key("s"));
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(store.session("s").unwrap().unwrap().status, SessionStatus::Completed);
        assert!(store.events_since("s", 0).unwrap().is_empty(), "关进程时报的状态不进时间线");
    }

    #[tokio::test]
    async fn sessions_in_use_are_kept() {
        // 刚用过。
        let (_store, runtimes) = resumable_runtimes();
        attach(&runtimes, 10 * MIN);
        assert_eq!(runtimes.release_idle(30 * MIN, 30 * MIN).await.unwrap(), 0);

        // 有人正看着。
        let (_store, runtimes) = resumable_runtimes();
        attach(&runtimes, 0);
        runtimes.set_viewing(1, Some("t".into())).unwrap();
        assert_eq!(runtimes.release_idle(30 * MIN, 30 * MIN).await.unwrap(), 0);

        // 还有排队。
        let (_store, runtimes) = resumable_runtimes();
        attach(&runtimes, 0);
        runtimes
            .record(
                "s",
                SessionEventBody::QueueChanged {
                    items: vec![QueuedTurn {
                        id: "q".into(),
                        text: "下一条".into(),
                        images: Vec::new(),
                        client_id: String::new(),
                    }],
                },
            )
            .unwrap();
        assert_eq!(runtimes.release_idle(30 * MIN, 30 * MIN).await.unwrap(), 0);

        // 没跑完，或者没有原生 id 接不回去。
        let (_store, runtimes) = runtimes_with_task(SessionStatus::Completed);
        let runtimes = Arc::new(runtimes);
        attach(&runtimes, 0);
        assert_eq!(runtimes.release_idle(30 * MIN, 30 * MIN).await.unwrap(), 0);
        for kept in [SessionStatus::Running, SessionStatus::NeedsInput, SessionStatus::Failed] {
            let (store, runtimes) = runtimes_with_task(kept);
            store.set_session_native_id("s", "thread-1").unwrap();
            let runtimes = Arc::new(runtimes);
            attach(&runtimes, 0);
            assert_eq!(runtimes.release_idle(30 * MIN, 30 * MIN).await.unwrap(), 0);
            assert!(runtimes.is_live("s"));
        }
    }

    /// 任务 `t` 的主对话是 `m`，侧边聊天是 `s`。
    fn side_runtimes() -> (Arc<Store>, Arc<Runtimes>) {
        let (store, runtimes) = runtimes_with_task(SessionStatus::Completed);
        let main = store.session("s").unwrap().unwrap();
        store.remove_session("s").unwrap();
        store.add_session(&TaskSession { id: "m".into(), ..main.clone() }).unwrap();
        store.add_side_session(&TaskSession { created_at: 2, ..main }).unwrap();
        (store, Arc::new(runtimes))
    }

    #[tokio::test]
    async fn side_chat_with_a_tab_survives_idle_release() {
        // 面板里有标签：窗口没焦点、没人看着也留着。
        let (store, runtimes) = side_runtimes();
        attach(&runtimes, 0);
        runtimes.set_side_tabs(1, vec!["t".into()]);
        assert_eq!(runtimes.release_idle(30 * MIN, 30 * MIN).await.unwrap(), 0);
        assert!(store.side_session("t").unwrap().is_some());

        // 那条连接关了标签（或断开）：接不回去，直接关掉；有人看着这个任务也一样。
        runtimes.set_side_tabs(1, Vec::new());
        runtimes.set_viewing(2, Some("t".into())).unwrap();
        assert_eq!(runtimes.release_idle(30 * MIN, 30 * MIN).await.unwrap(), 1);
        assert!(store.side_session("t").unwrap().is_none());
    }

    #[test]
    fn agent_leaving_plan_mode_is_kept_in_session_options() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let task = Task {
            id: "t".into(),
            project_id: None,
            title: String::new(),
            workspace: TaskWorkspace::Folder { path: "x".into() },
            pinned: false,
            archived_at: None,
            created_at: 1,
            updated_at: 1,
        };
        let session = TaskSession {
            id: "s".into(),
            task_id: "t".into(),
            agent: AgentKind::ClaudeCode,
            native_id: None,
            status: SessionStatus::Completed,
            options: SessionOptions {
                collaboration_mode: Some("plan".into()),
                model: Some("haiku".into()),
                ..Default::default()
            },
            created_at: 1,
            updated_at: 1,
        };
        store.insert_task(&task, &session).unwrap();
        let runtimes = Runtimes::new(store.clone(), Arc::new(Hub::new()), Arc::new(aiwb_agents::adapter_for));
        runtimes
            .record("s", SessionEventBody::CollaborationMode { mode: "default".into() })
            .unwrap();
        let options = store.session("s").unwrap().unwrap().options;
        assert_eq!(options.collaboration_mode, None);
        assert_eq!(options.model.as_deref(), Some("haiku"));
        runtimes
            .record("s", SessionEventBody::CollaborationMode { mode: "plan".into() })
            .unwrap();
        let options = store.session("s").unwrap().unwrap().options;
        assert_eq!(options.collaboration_mode.as_deref(), Some("plan"));
    }
}
