//! 正在运行的 Agent 会话和它们的时间线。
//!
//! 适配器把归一化事件写进通道；这里给每条事件定 seq 和 rev，写进数据库，再推给订阅者。
//! 同一条流的覆盖沿用原来的 seq，换一个新的 rev。
//! 会话按需接上：第一次发送、要目录或权限菜单时才启动 CLI；daemon 重启后用 resume 接回原线程。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use aiwb_agents::{AgentAdapter, AgentError, AgentSession, SessionContext, TurnDelivery, UserTurn};
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

pub type AdapterFactory = Arc<dyn Fn(AgentKind) -> Arc<dyn AgentAdapter> + Send + Sync>;

pub(crate) type RuntimeResult<T> = Result<T, String>;

/// 这次 daemon 运行期间碰过的会话的时间线。数据库仍是唯一来源，这份只为了归并流式覆盖。
struct Log {
    task_id: String,
    events: Vec<SessionEvent>,
    next_seq: u64,
    next_rev: u64,
    queue: Vec<QueuedTurn>,
}

pub struct Runtimes {
    store: Arc<Store>,
    hub: Arc<Hub>,
    adapters: AdapterFactory,
    logs: Mutex<HashMap<String, Log>>,
    live: Mutex<HashMap<String, Arc<dyn AgentSession>>>,
    /// 同一时间只打开一个会话，避免对同一线程起两个 CLI。
    opening: tokio::sync::Mutex<()>,
    /// 同一时间只探一次目录。等锁的一方拿到锁后先看缓存。
    pub(crate) probing: tokio::sync::Mutex<()>,
    /// 这次启动后拿到过新目录的 Agent。没拿到过的，存下的目录可能是旧的。
    pub(crate) fresh_catalogs: Mutex<HashSet<AgentKind>>,
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
                let task_id = self.hub.publish_with(&topic, || -> RuntimeResult<_> {
                    let mut logs = self.logs.lock().unwrap();
                    let log = self.log_mut(&mut logs, session_id)?;
                    let now = now_millis();
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
                    let stored = StoredEvent {
                        event,
                        rev: log.next_rev,
                    };
                    log.next_rev += 1;
                    self.store
                        .put_event(&log.task_id, &stored, activity)
                        .map_err(|e| e.to_string())?;
                    let feed = SessionFeed {
                        events: vec![stored],
                        ..Default::default()
                    };
                    let data = serde_json::to_value(feed).map_err(|e| e.to_string())?;
                    Ok((log.task_id.clone(), data))
                })?;
                let titled = match title {
                    Some(title) => self.adopt_title(&task_id, &title)?,
                    None => false,
                };
                if status || titled {
                    self.publish_tasks()?;
                }
                Ok(())
            }
        }
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
            logs.insert(
                session_id.to_string(),
                Log {
                    task_id: session.task_id,
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
        self.live.lock().unwrap().get(session_id).cloned()
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
        let resume = session.native_id.clone().filter(|id| !id.is_empty());
        let mut options = json!({ "persist": true, "skip_history": resume.is_some() });
        if let Some(access) = session.options.access.as_ref() {
            if !access.writable_roots.is_empty() {
                options["writable_roots"] = json!(access.writable_roots);
            }
        }
        let ctx = SessionContext {
            project_path: cwd,
            access_mode: session.options.access.as_ref().map(|access| access.mode.clone()),
            options,
            resume_native_id: resume,
        };
        let (tx, rx) = mpsc::unbounded_channel();
        self.spawn_pump(session_id.to_string(), rx);
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
        if session.native_id.is_none() {
            if let Some(native) = handle.native_id().filter(|id| !id.is_empty()) {
                self.store
                    .set_session_native_id(session_id, &native)
                    .map_err(store_err)?;
            }
        }
        apply_options(handle.as_ref(), &session.options).await;
        self.live
            .lock()
            .unwrap()
            .insert(session_id.to_string(), handle.clone());
        Ok(handle)
    }

    fn spawn_pump(self: &Arc<Self>, session_id: String, mut rx: mpsc::UnboundedReceiver<SessionEventBody>) {
        let runtimes = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(body) = rx.recv().await {
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
        let turn = UserTurn {
            text: text.clone(),
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
        let handle = self.live.lock().unwrap().remove(session_id);
        if let Some(handle) = handle {
            let _ = handle.stop().await;
        }
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
        let handles: Vec<_> = self.live.lock().unwrap().drain().map(|(_, h)| h).collect();
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
