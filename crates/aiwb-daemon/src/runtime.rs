//! 正在运行的 Agent 会话和它们的时间线。
//!
//! 适配器把归一化事件写进通道；这里给每条事件定 seq 和 rev，写进数据库，再推给订阅者。
//! 同一条流的覆盖沿用原来的 seq，换一个新的 rev。
//! 会话按需接上：第一次发送、要目录或权限菜单时才启动 CLI；daemon 重启后用 resume 接回原线程。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use aiwb_agents::{AgentAdapter, AgentError, AgentSession, SessionContext, TurnDelivery, UserTurn};
use aiwb_core::attention::{self, Attention, AttentionState};
use aiwb_core::models::{
    is_visible_user_body, is_visible_user_text, new_id, now_millis, AgentCatalog, AgentKind,
    BackgroundTaskStatus, MessageSender, PageAnnotation, QueuedTurn, SessionEvent,
    SessionEventBody, SessionStatus, SubagentStatus,
};
use aiwb_core::rpc::{session_topic, TOPIC_TASKS};
use aiwb_core::task::{SessionFeed, SessionOptions, StoredEvent, TaskWorkspace};
use aiwb_core::timeline::{is_conversation_activity, merge_into, subagent_ended, title_from_user_message};
use aiwb_store::Store;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::hub::Hub;

mod catalogs;
mod handoff;
mod prompts;
mod startup;
mod worktrees;

pub(crate) use worktrees::task_branch;

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
    /// 上次写库没成功，之后也没能按库里的重读：下次用到前先重读。
    stale: bool,
}

/// 接上的 CLI。`muted` 置上后它报的事件不再进时间线；`used_at` 是最后一次用到它或它报事件的时间。
struct Live {
    handle: Arc<dyn AgentSession>,
    muted: Arc<AtomicBool>,
    used_at: Arc<AtomicI64>,
    held: Held,
}

/// pump 压着还没写的那段流式输出。
type Held = Arc<Mutex<Option<SessionEventBody>>>;

/// 尚未写入 `turn_checkpoints` 表的预捕获检查点引用守卫：
/// 任何提前返回、投递失败、排队分支或异步取消都会在 `Drop` 中自动清理孤儿 Git 引用。
pub(crate) struct PendingPreCheckpoint {
    inner: Option<(String, String, aiwb_git::CapturedCheckpoint)>,
}

impl PendingPreCheckpoint {
    fn new(cp_id: String, cwd: String, captured: aiwb_git::CapturedCheckpoint) -> Self {
        Self {
            inner: Some((cp_id, cwd, captured)),
        }
    }

    fn take(&mut self) -> Option<(String, String, aiwb_git::CapturedCheckpoint)> {
        self.inner.take()
    }

    async fn discard_async(mut self) {
        if let Some((_, cwd, cap)) = self.inner.take() {
            let _ = tokio::task::spawn_blocking(move || {
                aiwb_git::delete_checkpoint_refs(std::path::Path::new(&cwd), &[cap.reference]);
            })
            .await;
        }
    }
}

impl Drop for PendingPreCheckpoint {
    fn drop(&mut self) {
        if let Some((_, cwd, cap)) = self.inner.take() {
            Runtimes::cleanup_checkpoint_ref(cwd, cap.reference);
        }
    }
}

const READ_ONLY: &str = "此会话正被其他进程占用，当前只读，不能发送。";

pub struct Runtimes {
    store: Arc<Store>,
    hub: Arc<Hub>,
    adapters: AdapterFactory,
    pub(crate) instances_root: std::path::PathBuf,
    custom_adapters: bool,
    adapter_cache: Mutex<HashMap<String, Arc<dyn AgentAdapter>>>,
    logs: Mutex<HashMap<String, Log>>,
    live: Mutex<HashMap<String, Live>>,
    /// 首轮启动的取消令牌；可见状态和首条说明始终保存在 SQLite。
    starting: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// 同一个会话同一时间只接一次，避免对同一线程起两个 CLI。不同会话互不等待。
    opening: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// 同步发送/批注在向适配器投递并落库用户气泡+检查点期间持锁，确保泵不会把本轮锚点/完成事件抢写到用户气泡之前。
    delivering: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// 手动从空闲队列发起新回合前预先拍下的 pre 检查点，待适配器回报对应 `UserMessage` 时消费绑定。
    pending_pre_checkpoints: Mutex<HashMap<String, PendingPreCheckpoint>>,
    /// 适配器确认原生会话已经没了的会话和那个原生 id。再用到时直接报，不再起 CLI。
    gone: Mutex<HashMap<String, String>>,
    /// 清理和恢复工作树一次只做一件，免得一边删一边恢复。
    pub(crate) worktrees: tokio::sync::Mutex<()>,
    /// 同一个实例同一时间只探一次目录。等锁的一方拿到锁后先看缓存。
    probing: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// 这次启动后各实例探目录的结果。没探成功过的，存下的目录可能是旧的。
    catalog_probes: Mutex<HashMap<String, aiwb_core::models::CatalogProbe>>,
    /// 正在探目录的 CLI。退出时一起关掉。
    probe_handles: Mutex<HashMap<String, Arc<dyn AgentSession>>>,
    /// 正在退出：不再起新的探测。
    closing: AtomicBool,
    /// 启动时正在收拾上次退出留下的会话。这时后台任务被记成停止不算回合结束，不回报父任务。
    restoring: AtomicBool,
    /// 每条连接正看着的任务。窗口没有焦点时界面会报空。
    viewing: Mutex<HashMap<u64, String>>,
    /// 每条连接的面板里开着侧边聊天标签的任务。有标签就不空闲回收。
    side_tabs: Mutex<HashMap<u64, HashSet<String>>>,
    /// 工作台 MCP 的凭证。随 Agent 进程发放和撤销。
    pub(crate) mcp: crate::mcp::Credentials,
    /// 会话状态变化。子任务回报从这里接。
    status_tx: mpsc::UnboundedSender<StatusNote>,
    status_rx: Mutex<Option<mpsc::UnboundedReceiver<StatusNote>>>,
}

/// 一个会话换了状态。
#[derive(Debug, Clone)]
pub(crate) struct StatusNote {
    pub(crate) task_id: String,
    pub(crate) status: SessionStatus,
}

/// 要发给 Agent 的一条消息。
pub(crate) struct Outgoing {
    pub(crate) text: String,
    pub(crate) images: Vec<String>,
    /// 回合进行中也立刻送进去（引导），不排队。
    pub(crate) now: bool,
    /// 工作台替子任务送的，不是用户打的字。
    pub(crate) sender: Option<MessageSender>,
    /// 放在正文前面一起送给 Agent 的工作台消息。时间线里单独折成一行，用户气泡仍只画用户写的。
    pub(crate) preface: Option<(String, MessageSender)>,
}

impl Outgoing {
    pub(crate) fn user(text: String, images: Vec<String>, now: bool) -> Self {
        Self {
            text,
            images,
            now,
            sender: None,
            preface: None,
        }
    }
}

impl Runtimes {
    #[cfg(test)]
    pub fn new(store: Arc<Store>, hub: Arc<Hub>, adapters: AdapterFactory) -> Self {
        Self::with_options(
            store,
            hub,
            adapters,
            std::env::temp_dir().join("aiwb-instances"),
            true,
        )
    }

    pub(crate) fn with_options(
        store: Arc<Store>,
        hub: Arc<Hub>,
        adapters: AdapterFactory,
        instances_root: std::path::PathBuf,
        custom_adapters: bool,
    ) -> Self {
        let (status_tx, status_rx) = mpsc::unbounded_channel();
        Self {
            store,
            hub,
            adapters,
            instances_root,
            custom_adapters,
            adapter_cache: Mutex::default(),
            logs: Mutex::default(),
            live: Mutex::default(),
            starting: Mutex::default(),
            opening: Mutex::default(),
            delivering: Mutex::default(),
            pending_pre_checkpoints: Mutex::default(),
            gone: Mutex::default(),
            worktrees: tokio::sync::Mutex::new(()),
            probing: Mutex::default(),
            catalog_probes: Mutex::default(),
            probe_handles: Mutex::default(),
            closing: AtomicBool::new(false),
            restoring: AtomicBool::new(false),
            viewing: Mutex::default(),
            side_tabs: Mutex::default(),
            mcp: crate::mcp::Credentials::default(),
            status_tx,
            status_rx: Mutex::new(Some(status_rx)),
        }
    }

    fn opening_of(&self, session_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.opening.lock().unwrap().entry(session_id.to_string()).or_default().clone()
    }

    fn delivering_of(&self, session_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.delivering
            .lock()
            .unwrap()
            .entry(session_id.to_string())
            .or_default()
            .clone()
    }

    /// 状态变化的接收端。只能取一次。
    pub(crate) fn take_status_notes(&self) -> Option<mpsc::UnboundedReceiver<StatusNote>> {
        self.status_rx.lock().unwrap().take()
    }

    pub(crate) fn adapter(&self, agent: AgentKind) -> Arc<dyn AgentAdapter> {
        self.adapter_for_instance(agent, None)
            .unwrap_or_else(|_| (self.adapters)(agent))
    }

    pub(crate) fn adapter_for_instance(
        &self,
        agent: AgentKind,
        instance_id: Option<&str>,
    ) -> RuntimeResult<Arc<dyn AgentAdapter>> {
        let key = catalogs::instance_key(agent, instance_id);
        let is_default = key == aiwb_core::models::default_instance_id(agent);
        if !is_default {
            let inst = self
                .store
                .agent_instance(&key)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| {
                    format!(
                        "自定义实例「{key}」已被删除或不存在，为避免误用默认账号，请先切换实例后再操作"
                    )
                })?;
            if inst.kind != agent {
                return Err(format!(
                    "实例「{key}」与 Agent 类型 {} 不匹配",
                    agent.display_name()
                ));
            }
            if self.custom_adapters {
                return Ok((self.adapters)(agent));
            }
            if let Some(cached) = self.adapter_cache.lock().unwrap().get(&key).cloned() {
                return Ok(cached);
            }
            let overlay = aiwb_agents::InstanceOverlay::from_instance(&inst, &self.instances_root);
            let built = aiwb_agents::adapter_for_overlay(inst.kind, overlay);
            self.adapter_cache
                .lock()
                .unwrap()
                .insert(key, Arc::clone(&built));
            return Ok(built);
        }

        if self.custom_adapters {
            return Ok((self.adapters)(agent));
        }
        if let Some(cached) = self.adapter_cache.lock().unwrap().get(&key).cloned() {
            return Ok(cached);
        }
        let built = if let Ok(Some(inst)) = self.store.agent_instance(&key) {
            let overlay = aiwb_agents::InstanceOverlay::from_instance(&inst, &self.instances_root);
            aiwb_agents::adapter_for_overlay(inst.kind, overlay)
        } else {
            (self.adapters)(agent)
        };
        self.adapter_cache
            .lock()
            .unwrap()
            .insert(key, Arc::clone(&built));
        Ok(built)
    }

    pub(crate) fn invalidate_instance_adapter(&self, instance_id: &str) {
        self.adapter_cache.lock().unwrap().remove(instance_id);
        aiwb_agents::evict_instance_caches(instance_id);
    }

    pub(crate) fn session_adapter(
        &self,
        session: &aiwb_core::task::TaskSession,
    ) -> RuntimeResult<Arc<dyn AgentAdapter>> {
        self.adapter_for_instance(session.agent, session.instance_id.as_deref())
    }

    pub(crate) fn clear_session_cache(&self, session_id: &str) {
        self.clear_pending_pre_checkpoint(session_id);
        self.logs.lock().unwrap().remove(session_id);
        self.gone.lock().unwrap().remove(session_id);
    }

    fn cleanup_checkpoint_ref(cwd: String, reference: String) {
        let cwd_path = std::path::PathBuf::from(cwd);
        let refs = [reference];
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn_blocking(move || {
                aiwb_git::delete_checkpoint_refs(&cwd_path, &refs);
            });
        } else {
            aiwb_git::delete_checkpoint_refs(&cwd_path, &refs);
        }
    }

    pub(crate) fn stash_pending_pre_checkpoint(
        &self,
        session_id: &str,
        pre: PendingPreCheckpoint,
    ) {
        let _ = self
            .pending_pre_checkpoints
            .lock()
            .unwrap()
            .insert(session_id.to_string(), pre);
    }

    fn take_pending_pre_checkpoint(&self, session_id: &str) -> Option<PendingPreCheckpoint> {
        self.pending_pre_checkpoints.lock().unwrap().remove(session_id)
    }

    pub(crate) fn clear_pending_pre_checkpoint(&self, session_id: &str) {
        let _ = self.pending_pre_checkpoints.lock().unwrap().remove(session_id);
    }

    pub(crate) async fn capture_pre_checkpoint(
        &self,
        session_id: &str,
    ) -> Option<PendingPreCheckpoint> {
        if self.store.is_side_session(session_id).unwrap_or(false) {
            return None;
        }
        let cwd_str = self.workdir(session_id).ok()?;
        let cwd = std::path::PathBuf::from(&cwd_str);
        let cp_id = new_id();
        let cp_id_clone = cp_id.clone();
        let sid_clone = session_id.to_string();
        let captured = tokio::task::spawn_blocking(move || {
            aiwb_git::capture_checkpoint(&cwd, &sid_clone, &cp_id_clone, "pre")
                .ok()
                .flatten()
        })
        .await
        .ok()??;
        Some(PendingPreCheckpoint::new(cp_id, cwd_str, captured))
    }

    pub(crate) fn save_turn_checkpoint(
        &self,
        session_id: &str,
        user_event_id: Option<&str>,
        mut pre: PendingPreCheckpoint,
    ) {
        let (task_id, event_id, cut_seq, turn_id) = {
            let mut logs = self.logs.lock().unwrap();
            let Ok(log) = self.log_mut(&mut logs, session_id) else {
                return;
            };
            let ev_idx = match user_event_id {
                Some(target_id) => log.events.iter().rposition(|e| e.id == target_id),
                None => log.events.iter().rposition(|e| is_visible_user_body(&e.body)),
            };
            let Some(idx) = ev_idx else {
                return;
            };
            let event_id = log.events[idx].id.clone();
            let (cut_seq, turn_id) =
                crate::services::checkpoints::compute_turn_cut_seq(&log.events, idx);
            (log.task_id.clone(), event_id, cut_seq, turn_id)
        };
        let Some((cp_id, cwd_str, cap)) = pre.take() else {
            return;
        };
        let now = now_millis();
        let pre_ref = cap.reference.clone();
        let cp = aiwb_core::checkpoint::TurnCheckpoint {
            id: cp_id,
            task_id,
            session_id: session_id.to_string(),
            user_event_id: event_id,
            cut_seq,
            turn_id,
            pre_ref: Some(cap.reference),
            post_ref: None,
            head_oid: cap.head_oid,
            branch: cap.branch,
            cwd: cwd_str.clone(),
            created_at: now,
            updated_at: now,
        };
        if self.store.put_checkpoint(&cp).is_err() {
            Self::cleanup_checkpoint_ref(cwd_str, pre_ref);
        }
    }

    /// 会话进程已被静默关停但未执行回退截断时（如 Git 文件恢复失败），将仍在运行/等待输入的会话及后台卡片同步收敛为已停止。
    pub(crate) fn settle_stopped_session(&self, session_id: &str) -> RuntimeResult<()> {
        let had_queue = self
            .logs
            .lock()
            .unwrap()
            .get(session_id)
            .is_some_and(|log| !log.queue.is_empty());
        if had_queue {
            let _ = self.write_event_ext(
                session_id,
                SessionEventBody::QueueChanged { items: Vec::new() },
                None,
                false,
            );
        }
        self.expire_prompts(session_id, None)?;
        self.stop_background(session_id)?;
        if let Some(session) = self.store.session(session_id).map_err(|e| e.to_string())? {
            if matches!(
                session.status,
                SessionStatus::Starting | SessionStatus::Running | SessionStatus::NeedsInput
            ) {
                self.record(
                    session_id,
                    SessionEventBody::StatusChanged {
                        status: SessionStatus::Stopped,
                    },
                )?;
            }
        }
        Ok(())
    }

    pub(crate) fn settle_stopped_task(&self, task_id: &str) -> RuntimeResult<()> {
        for session in self.store.task_sessions(task_id).map_err(|e| e.to_string())? {
            if !self.is_live(&session.id) {
                self.settle_stopped_session(&session.id)?;
            }
        }
        for side in self
            .store
            .task_side_sessions(task_id)
            .map_err(|e| e.to_string())?
        {
            if !self.is_live(&side.id) {
                self.settle_stopped_session(&side.id)?;
            }
        }
        Ok(())
    }

    /// 上次退出时还在跑或在等输入的会话，那一轮已经断了。记一条停止状态。
    /// 还在跑的子 Agent 和后台任务也跟着停了：按时间线里记着的找，不看会话状态。
    /// 主回合被打断后后台命令还在跑的会话是「已停止」，侧栏也不算在做，不能漏。
    pub(crate) fn settle_interrupted(&self) -> RuntimeResult<()> {
        let sessions = self.store.list_sessions().map_err(|e| e.to_string())?;
        let running = self.store.sessions_with_running_background().map_err(|e| e.to_string())?;
        self.restoring.store(true, Ordering::SeqCst);
        let settled = self.settle_sessions(sessions, &running);
        self.restoring.store(false, Ordering::SeqCst);
        settled
    }

    fn settle_sessions(&self, sessions: Vec<aiwb_core::task::TaskSession>, running: &HashSet<String>) -> RuntimeResult<()> {
        for session in sessions {
            self.expire_prompts(&session.id, None)?;
            let interrupted = matches!(session.status, SessionStatus::Starting | SessionStatus::Running | SessionStatus::NeedsInput);
            if running.contains(&session.id) {
                self.stop_background(&session.id)?;
            }
            if interrupted {
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

    /// Agent 进程不在了，还记着在跑的子 Agent 和后台任务也跟着停了。
    fn stop_background(&self, session_id: &str) -> RuntimeResult<()> {
        let events = self.store.events_since(session_id, 0).map_err(|e| e.to_string())?;
        let now = now_millis();
        for stored in events {
            match stored.event.body {
                SessionEventBody::Subagent(mut card) if card.status == SubagentStatus::Running => {
                    card.finish(SubagentStatus::Stopped, Some(now));
                    self.record(session_id, SessionEventBody::Subagent(card))?;
                }
                SessionEventBody::BackgroundTask(mut task) if task.running() => {
                    task.finish(BackgroundTaskStatus::Stopped, Some(now));
                    self.record(session_id, SessionEventBody::BackgroundTask(task))?;
                }
                _ => {}
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

    /// 一条连接报它的面板里哪些侧边会话有标签。连接断开时报空。
    pub(crate) fn set_side_tabs(&self, connection: u64, session_ids: Vec<String>) {
        let mut tabs = self.side_tabs.lock().unwrap();
        if session_ids.is_empty() {
            tabs.remove(&connection);
        } else {
            tabs.insert(connection, session_ids.into_iter().collect());
        }
    }

    fn has_side_tab(&self, session_id: &str) -> bool {
        self.side_tabs.lock().unwrap().values().any(|ids| ids.contains(session_id))
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
            SessionEventBody::Subagent(_) | SessionEventBody::BackgroundTask(_) => {
                attention::on_background(&prev()?, events, self.is_viewed(task_id), now)
            }
            _ => None,
        })
    }

    pub(crate) fn publish_tasks(&self) -> RuntimeResult<()> {
        self.hub.publish_with(TOPIC_TASKS, || {
            let entries = self.task_entries()?;
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
    /// pump 压着的那段流式输出先写出去，这条不排到它前面。
    pub(crate) fn record(&self, session_id: &str, body: SessionEventBody) -> RuntimeResult<()> {
        let _ = self.record_with_checkpoint(session_id, body, None)?;
        Ok(())
    }

    fn record_with_checkpoint(
        &self,
        session_id: &str,
        body: SessionEventBody,
        pre_checkpoint: Option<PendingPreCheckpoint>,
    ) -> RuntimeResult<Option<String>> {
        let entry = self
            .live
            .lock()
            .unwrap()
            .get(session_id)
            .map(|entry| (entry.held.clone(), entry.muted.clone()));
        if let Some((held, muted)) = entry {
            let mut slot = held.lock().unwrap();
            if let Some(earlier) = slot.take().filter(|_| !muted.load(Ordering::SeqCst)) {
                if let Err(err) = self.write_event_ext(session_id, earlier, None, true) {
                    eprintln!("记录会话 {session_id} 的事件失败：{err}");
                }
            }
        }
        self.write_event_ext(session_id, body, pre_checkpoint, false)
    }

    fn write_adapter_event(&self, session_id: &str, body: SessionEventBody) -> RuntimeResult<()> {
        let _ = self.write_event_ext(session_id, body, None, true)?;
        Ok(())
    }

    fn write_event_ext(
        &self,
        session_id: &str,
        body: SessionEventBody,
        pre_checkpoint: Option<PendingPreCheckpoint>,
        from_adapter: bool,
    ) -> RuntimeResult<Option<String>> {
        let topic = session_topic(session_id);
        match body {
            // 适配器请求宿主另开会话。任务里还没有这个入口，不进时间线。
            SessionEventBody::NewThread { .. } => Ok(None),
            SessionEventBody::QueueChanged { items } => self
                .hub
                .publish_with(&topic, || {
                    let mut logs = self.logs.lock().unwrap();
                    let log = self.log_mut(&mut logs, session_id)?;
                    log.queue = items.clone();
                    let feed = SessionFeed {
                        queue: Some(items),
                        ..Default::default()
                    };
                    Ok(((), serde_json::to_value(feed).map_err(|e| e.to_string())?))
                })
                .map(|()| None),
            body => {
                if let SessionEventBody::CollaborationMode { mode } = &body {
                    self.keep_collaboration_mode(session_id, mode)?;
                }
                let anchor_turn_id = match &body {
                    SessionEventBody::TurnAnchor { turn_id, .. } if !turn_id.trim().is_empty() => {
                        Some(turn_id.clone())
                    }
                    _ => None,
                };
                let is_user_msg = is_visible_user_body(&body);
                let status = match &body {
                    SessionEventBody::StatusChanged { status } => Some(*status),
                    _ => None,
                };
                // 工作台替子任务送来的消息不当标题。
                let title = match &body {
                    SessionEventBody::UserMessage {
                        text,
                        images,
                        annotations,
                        sender: None,
                    } => title_from_user_message(text, images.len(), *annotations),
                    _ => None,
                };
                let activity = is_conversation_activity(&body);
                let (task_id, side, attention_changed, settled, event_id) =
                    self.append_at(session_id, body, activity, now_millis())?;
                if !side {
                    if let Some(pre) = pre_checkpoint {
                        self.save_turn_checkpoint(session_id, Some(&event_id), pre);
                    }
                    if let Some(turn_id) = anchor_turn_id {
                        if let Ok(cps) = self.store.session_checkpoints(session_id) {
                            if let Some(last) = cps
                                .last()
                                .filter(|c| c.turn_id.is_none() && c.post_ref.is_none())
                            {
                                let _ = self.store.update_checkpoint_turn_id(
                                    &last.id,
                                    &turn_id,
                                    now_millis(),
                                );
                            }
                        }
                    }
                }
                let titled = match title {
                    Some(title) if !side => self.adopt_title(&task_id, &title)?,
                    _ => false,
                };
                if status.is_some() || attention_changed || titled {
                    self.publish_tasks()?;
                }
                // 重启收拾时后台任务被记成停止，是进程没了，不是这一轮做完了。
                let is_restoring = self.restoring.load(Ordering::SeqCst);
                let restoring = status.is_none() && is_restoring;
                if let Some(status) = settled.filter(|_| !side && !restoring) {
                    if !is_restoring {
                        self.capture_post_checkpoint_bg(session_id, &task_id);
                    }
                    let _ = self.status_tx.send(StatusNote { task_id, status });
                } else if from_adapter && is_user_msg && !side && !is_restoring {
                    if let Some(pre) = self.take_pending_pre_checkpoint(session_id) {
                        self.save_turn_checkpoint(session_id, Some(&event_id), pre);
                    } else {
                        self.save_unanchored_turn_checkpoint(session_id, &event_id);
                    }
                }
                Ok(Some(event_id))
            }
        }
    }

    /// 并进时间线、写库、推给订阅者，返回任务 id、是不是侧边聊天、注意力有没有变、会话是不是真换了状态（换成了哪个）、事件 id。
    /// `activity` 时把任务的更新时间挪到 `now`，侧边聊天不挪。
    /// 状态事件的注意力和事件写在同一个事务里。分叉复制时间线时沿用原来的时间，回合用时才对得上。
    fn append_at(
        &self,
        session_id: &str,
        body: SessionEventBody,
        activity: bool,
        now: i64,
    ) -> RuntimeResult<(String, bool, bool, Option<SessionStatus>, String)> {
        let topic = session_topic(session_id);
        let mut ended = None;
        let appended = self.hub.publish_with(&topic, || -> RuntimeResult<_> {
            let mut logs = self.logs.lock().unwrap();
            let appended = self.append_locked(&mut logs, session_id, body, activity, now, &mut ended);
            if appended.is_err() {
                self.resync(&mut logs, session_id);
            }
            appended
        })?;
        if let Some(ended) = ended {
            let _ = self.append_at(session_id, ended, activity, now)?;
        }
        Ok(appended)
    }

    /// 写库没成功时副本里已经并进去了：按库里的重读一遍。这次读不了就记着，下次用到前再读。排队留着。
    fn resync(&self, logs: &mut HashMap<String, Log>, session_id: &str) {
        if let Some(log) = logs.get_mut(session_id) {
            if self.reload(log, session_id).is_err() {
                log.stale = true;
            }
        }
    }

    fn reload(&self, log: &mut Log, session_id: &str) -> RuntimeResult<()> {
        let stored = self.store.events_since(session_id, 0).map_err(|e| e.to_string())?;
        log.next_seq = stored.iter().map(|item| item.event.seq).max().unwrap_or(0) + 1;
        log.next_rev = stored.iter().map(|item| item.rev).max().unwrap_or(0) + 1;
        log.events = stored.into_iter().map(|item| item.event).collect();
        log.stale = false;
        Ok(())
    }

    #[allow(clippy::type_complexity)]
    fn append_locked(
        &self,
        logs: &mut HashMap<String, Log>,
        session_id: &str,
        body: SessionEventBody,
        activity: bool,
        now: i64,
        ended: &mut Option<SessionEventBody>,
    ) -> RuntimeResult<((String, bool, bool, Option<SessionStatus>, String), Value)> {
        {
            let log = self.log_mut(logs, session_id)?;
            *ended = subagent_ended(&log.events, &body);
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
            let event_id = event.id.clone();
            let attention = self.next_attention(session_id, &log.task_id, &event.body, &log.events, now)?;
            // 状态事件的注意力变了，才是真换了状态（新会话接上时报的「已完成」不算）。
            // 主回合完了还有后台的在跑时注意力不变；最后一个跑完、从「在做」变成完成时，这一轮才算真结束。
            let settled = attention.as_ref().and_then(|attention| match &event.body {
                SessionEventBody::StatusChanged { status } => Some(*status),
                SessionEventBody::Subagent(_) | SessionEventBody::BackgroundTask(_)
                    if attention.state != AttentionState::Working =>
                {
                    attention::last_status(&log.events)
                }
                _ => None,
            });
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
            Ok((
                (
                    log.task_id.clone(),
                    log.side,
                    attention.is_some(),
                    settled,
                    event_id,
                ),
                data,
            ))
        }
    }

    /// 改写时间线里已有的一条：沿用 seq，换新的 rev。
    pub(crate) fn rewrite(&self, session_id: &str, event_id: &str, body: SessionEventBody) -> RuntimeResult<()> {
        let topic = session_topic(session_id);
        self.hub.publish_with(&topic, || -> RuntimeResult<_> {
            let mut logs = self.logs.lock().unwrap();
            let log = self.log_mut(&mut logs, session_id)?;
            let index = log
                .events
                .iter()
                .position(|event| event.id == event_id)
                .ok_or_else(|| "时间线里没有这条事件".to_string())?;
            // 先写库，写成了再改副本。
            let stored = StoredEvent {
                event: SessionEvent { body, ..log.events[index].clone() },
                rev: log.next_rev,
            };
            self.store
                .put_event(&log.task_id, &stored, false, None)
                .map_err(|e| e.to_string())?;
            log.next_rev += 1;
            log.events[index] = stored.event.clone();
            let feed = SessionFeed {
                events: vec![stored],
                ..Default::default()
            };
            Ok(((), serde_json::to_value(feed).map_err(|e| e.to_string())?))
        })
    }

    /// 会话删掉之前：停掉 CLI，丢掉这里的时间线副本。
    pub(crate) async fn discard(&self, session_id: &str) {
        self.stop_and_mute(session_id).await;
        self.logs.lock().unwrap().remove(session_id);
    }

    /// 关掉侧边聊天：停进程，删会话、时间线和没发的草稿。
    /// 等正在接的 CLI 接完再关，免得刚分出来的进程没人管。
    pub(crate) async fn discard_side(&self, session_id: &str) -> RuntimeResult<()> {
        let _opening = self.opening_of(session_id).lock_owned().await;
        self.remove_side(session_id).await
    }

    /// 调用方拿着 `opening`。
    async fn remove_side(&self, session_id: &str) -> RuntimeResult<()> {
        self.mcp.revoke(session_id);
        let entry = self.live.lock().unwrap().remove(session_id);
        if let Some(entry) = entry {
            entry.muted.store(true, Ordering::SeqCst);
            *entry.held.lock().unwrap() = None;
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

    /// 原生会话里应该已经有对话：Agent 回过用户的消息，也没有还没交出去的前文。
    /// 分叉和换 Agent 抄来了前文，但原生会话要等第一条消息发出去才有内容。
    fn has_native_history(&self, session_id: &str) -> RuntimeResult<bool> {
        let mut logs = self.logs.lock().unwrap();
        let log = self.log_mut(&mut logs, session_id)?;
        let (mut asked, mut answered) = (false, false);
        for event in &log.events {
            match event.body {
                SessionEventBody::Handoff { delivered: false, .. } => return Ok(false),
                SessionEventBody::UserMessage { .. } => asked = true,
                SessionEventBody::AgentMessage { .. } if asked => answered = true,
                _ => {}
            }
        }
        Ok(answered)
    }

    /// 原生协议不保存目标的适配器从事件恢复；清除事件也要带上，不能退回更早的目标。
    fn saved_goal(&self, session_id: &str) -> RuntimeResult<Option<Value>> {
        let mut logs = self.logs.lock().unwrap();
        let log = self.log_mut(&mut logs, session_id)?;
        log.events.iter().rev()
            .find(|event| matches!(event.body, SessionEventBody::Goal { .. }))
            .map(|event| serde_json::to_value(&event.body).map_err(|err| err.to_string()))
            .transpose()
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
                    stale: false,
                },
            );
        }
        let log = logs.get_mut(session_id).expect("log just inserted");
        if log.stale {
            self.reload(log, session_id)?;
        }
        Ok(log)
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

    pub(crate) fn workdir_of_task(&self, task_id: &str) -> RuntimeResult<String> {
        let store_err = |e: aiwb_store::StoreError| e.to_string();
        let task = self
            .store
            .task(task_id)
            .map_err(store_err)?
            .ok_or_else(|| "任务不存在".to_string())?;
        Ok(match task.workspace {
            TaskWorkspace::Worktree { local: None, path, .. } | TaskWorkspace::Folder { path } => path,
            // 交给了项目目录的工作树任务，在项目目录里干活。
            TaskWorkspace::Worktree { local: Some(_), .. } | TaskWorkspace::Root => {
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
        // 工作树任务从拿到目录到 CLI 接上一直拿着工作树锁：清理、交接要么等它接上（之后能停掉它），
        // 要么做完了它再按新状态接上。被清理过的先放回来，CLI 才有目录可进；交给了项目目录的不用。
        let mut restored = false;
        let mut _worktree_guard = None;
        if let Some(session) = self.store.session(session_id).map_err(|e| e.to_string())? {
            let task = self.store.task(&session.task_id).map_err(|e| e.to_string())?;
            if matches!(task.as_ref().map(|task| &task.workspace), Some(TaskWorkspace::Worktree { .. })) {
                _worktree_guard = Some(self.worktrees.lock().await);
                let task = self.store.task(&session.task_id).map_err(|e| e.to_string())?;
                if matches!(
                    task.map(|task| task.workspace),
                    Some(TaskWorkspace::Worktree { local: None, .. })
                ) {
                    restored = self.restore_worktree_locked(&session.task_id).await?;
                }
            }
        }
        // 侧边聊天从主对话的原生会话分出来：先等主对话接完（它可能正在换原生会话）。顺序固定主 → 侧。
        let _parent_opening = match self.side_main(session_id)? {
            Some(main) => Some(self.opening_of(&main).lock_owned().await),
            None => None,
        };
        let _opening = self.opening_of(session_id).lock_owned().await;
        if self.initial_cancelled(session_id) { return Err("启动已取消".into()); }
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
        self.expire_prompts(session_id, None)?;
        let side_of = if self.store.is_side_session(session_id).map_err(store_err)? {
            Some(self.side_parent(&session)?)
        } else {
            None
        };
        let resume = session.native_id.clone().filter(|id| !id.is_empty());
        if side_of.is_none() && resume.is_some() && self.gone.lock().unwrap().get(session_id) == resume.as_ref() {
            return Err(AgentError::SessionGone.to_string());
        }
        let mut options = match &side_of {
            Some(parent) => json!({ "persist": false, "side_of": parent }),
            None => json!({ "persist": true, "skip_history": resume.is_some() }),
        };
        if side_of.is_none() && resume.is_some() && self.has_native_history(session_id)? {
            options["has_history"] = json!(true);
        }
        if side_of.is_none() && resume.is_some() {
            if let Some(goal) = self.saved_goal(session_id)? {
                options["saved_goal"] = goal;
            }
        }
        if let Some(access) = session.options.access.as_ref() {
            if !access.writable_roots.is_empty() {
                options["writable_roots"] = json!(access.writable_roots);
            }
        }
        // 工作台 MCP 现在只有子任务工具：哪个会话都发，层数不限；侧边聊天不发。
        let session_adapter = self.session_adapter(&session)?;
        let workbench_mcp = (side_of.is_none() && session_adapter.takes_workbench_mcp())
            .then(|| self.mcp.issue(session_id))
            .flatten()
            .map(|mut mcp| {
                mcp.child = self.store.task(&session.task_id).ok().flatten().is_some_and(|task| task.parent_task_id.is_some());
                mcp
            });
        let ctx = SessionContext {
            project_path: cwd,
            access_mode: session.options.access.as_ref().map(|access| access.mode.clone()),
            options,
            resume_native_id: if side_of.is_some() { None } else { resume.clone() },
            workbench_mcp,
        };
        let (tx, rx) = mpsc::unbounded_channel();
        let muted = Arc::new(AtomicBool::new(false));
        let used_at = Arc::new(AtomicI64::new(now_millis()));
        let held = Held::default();
        self.spawn_pump(session_id.to_string(), rx, muted.clone(), used_at.clone(), held.clone());
        let handle = match session_adapter.start_session(ctx, tx).await {
            Ok(handle) => handle,
            Err(err) => {
                self.mcp.revoke(session_id);
                if self.initial_cancelled(session_id) { return Err("启动已取消".into()); }
                if let (AgentError::SessionGone, Some(native), None) = (&err, resume.as_ref(), side_of.as_ref()) {
                    self.gone.lock().unwrap().insert(session_id.to_string(), native.clone());
                }
                let message = err.to_string();
                self.record_initial_failure(session_id, message.clone())?;
                return Err(message);
            }
        };
        if self.initial_cancelled(session_id) {
            muted.store(true, Ordering::SeqCst);
            self.mcp.revoke(session_id);
            let _ = handle.stop().await;
            return Err("启动已取消".into());
        }
        // 适配器换了原生会话（例如 Cursor 没发过消息的空会话不能载入，只能新开）时跟着改。
        if let Some(native) = handle.native_id().filter(|id| !id.is_empty()) {
            if session.native_id.as_deref() != Some(native.as_str()) {
                self.store
                    .set_session_native_id(session_id, &native)
                    .map_err(store_err)?;
            }
        }
        apply_options(handle.as_ref(), &session.options).await;
        // 打开会话时那次推目标因为工作树清理掉了被跳过，恢复后补上。
        if restored {
            let _ = handle.publish_goal().await;
        }
        self.live.lock().unwrap().insert(
            session_id.to_string(),
            Live {
                handle: handle.clone(),
                muted,
                used_at,
                held,
            },
        );
        Ok(handle)
    }

    /// 侧边聊天所在任务现在用的主对话。不是侧边聊天时为空。
    fn side_main(&self, session_id: &str) -> RuntimeResult<Option<String>> {
        let store_err = |e: aiwb_store::StoreError| e.to_string();
        if !self.store.is_side_session(session_id).map_err(store_err)? {
            return Ok(None);
        }
        let Some(side) = self.store.session(session_id).map_err(store_err)? else {
            return Ok(None);
        };
        Ok(self.store.task_sessions(&side.task_id).map_err(store_err)?.pop().map(|main| main.id))
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
        held: Held,
    ) {
        let runtimes = Arc::clone(self);
        let cancelled = self.starting.lock().unwrap().get(&session_id).cloned();
        let mut awaiting_turn = self.store.session(&session_id).ok().flatten()
            .is_some_and(|s| matches!(s.status, SessionStatus::Starting | SessionStatus::Idle));
        tokio::spawn(async move {
            let lock_starting = || cancelled.as_ref().map(|_| runtimes.starting.lock().unwrap());
            // 调用方拿着 `starting`（首轮启动时）和 `held`。
            let emit = |body: SessionEventBody| {
                if cancelled.as_ref().is_some_and(|c| c.load(Ordering::SeqCst)) || muted.load(Ordering::SeqCst) {
                    return;
                }
                used_at.store(now_millis(), Ordering::SeqCst);
                if let Err(err) = runtimes.write_adapter_event(&session_id, body) {
                    eprintln!("记录会话 {session_id} 的事件失败：{err}");
                }
            };
            // 同一条流的全文覆盖来得再密，也隔 `STREAM_INTERVAL` 才写一次库、推一次；压着的那条只留最新的。
            // 别的事件一到，压着的先写，顺序不变。
            let mut last_stream: Option<tokio::time::Instant> = None;
            loop {
                let waiting = held.lock().unwrap().is_some();
                let received = match last_stream.filter(|_| waiting) {
                    Some(last) => tokio::select! {
                        received = rx.recv() => received,
                        _ = tokio::time::sleep_until(last + STREAM_INTERVAL) => {
                            let _delivering = runtimes.delivering_of(&session_id).lock_owned().await;
                            {
                                let _starting = lock_starting();
                                if let Some(body) = held.lock().unwrap().take() {
                                    emit(body);
                                }
                            }
                            last_stream = Some(tokio::time::Instant::now());
                            continue;
                        }
                    },
                    None => rx.recv().await,
                };
                let _delivering = runtimes.delivering_of(&session_id).lock_owned().await;
                let Some(mut body) = received else {
                    let _starting = lock_starting();
                    if let Some(body) = held.lock().unwrap().take() {
                        emit(body);
                    }
                    break;
                };
                if let SessionEventBody::StatusChanged { status } = &body {
                    // 原生进程接通时的 idle 不是首轮完成；直到真正开始回合才接收完成状态。
                    if awaiting_turn && *status == SessionStatus::Completed { continue; }
                    if matches!(status, SessionStatus::Running | SessionStatus::NeedsInput | SessionStatus::Failed) {
                        awaiting_turn = false;
                    }
                }
                let _starting = lock_starting();
                let mut slot = held.lock().unwrap();
                if let Some(earlier) = slot.take() {
                    match absorb_stream(earlier, body) {
                        Ok(merged) => {
                            *slot = Some(merged);
                            continue;
                        }
                        Err(pair) => {
                            let (earlier, next) = *pair;
                            emit(earlier);
                            last_stream = Some(tokio::time::Instant::now());
                            body = next;
                        }
                    }
                }
                if is_stream_overwrite(&body) {
                    if last_stream.is_some_and(|last| last.elapsed() < STREAM_INTERVAL) {
                        *slot = Some(body);
                        continue;
                    }
                    last_stream = Some(tokio::time::Instant::now());
                }
                emit(body);
            }
        });
    }

    /// 进程已经退出的句柄扔掉，下次用到时重新接上。
    /// 只扔 `dead` 这一个：别的调用已经重新接上时，新句柄留着。
    fn forget(&self, session_id: &str, dead: &Arc<dyn AgentSession>) {
        let mut live = self.live.lock().unwrap();
        if live.get(session_id).is_some_and(|entry| Arc::ptr_eq(&entry.handle, dead)) {
            live.remove(session_id);
            self.mcp.revoke(session_id);
        }
    }

    /// 跑一个要句柄的操作。CLI 已经退出时重新接上再试一次。
    pub(crate) async fn with_handle<T, F, Fut>(self: &Arc<Self>, session_id: &str, work: F) -> RuntimeResult<T>
    where
        F: Fn(Arc<dyn AgentSession>) -> Fut,
        Fut: std::future::Future<Output = Result<T, AgentError>>,
    {
        self.with_live(session_id, false, work).await
    }

    /// 同 [`Self::with_handle`]，给要往会话里发东西的操作：只读的句柄（包括重新接上的）直接拒绝。
    pub(crate) async fn with_writer<T, F, Fut>(self: &Arc<Self>, session_id: &str, work: F) -> RuntimeResult<T>
    where
        F: Fn(Arc<dyn AgentSession>) -> Fut,
        Fut: std::future::Future<Output = Result<T, AgentError>>,
    {
        self.with_live(session_id, true, work).await
    }

    async fn with_live<T, F, Fut>(self: &Arc<Self>, session_id: &str, writes: bool, work: F) -> RuntimeResult<T>
    where
        F: Fn(Arc<dyn AgentSession>) -> Fut,
        Fut: std::future::Future<Output = Result<T, AgentError>>,
    {
        let handle = self.ensure_live(session_id).await?;
        if writes && handle.read_only() {
            return Err(READ_ONLY.into());
        }
        match work(handle.clone()).await {
            Err(AgentError::Closed) => {
                self.forget(session_id, &handle);
                let handle = self.ensure_live(session_id).await?;
                if writes && handle.read_only() {
                    return Err(READ_ONLY.into());
                }
                work(handle).await.map_err(|e| e.to_string())
            }
            other => other.map_err(|e| e.to_string()),
        }
    }

    /// 发一条消息。斜杠命令不画用户气泡；排队的消息等真正发出时由适配器记。
    pub(crate) async fn send_message(self: &Arc<Self>, session_id: &str, message: Outgoing) -> RuntimeResult<TurnDelivery> {
        if self.starting.lock().unwrap().contains_key(session_id) {
            return Err("会话正在准备，请稍后再发送。".into());
        }
        let Outgoing {
            text,
            images,
            now,
            sender,
            preface,
        } = message;
        if text.trim().is_empty() && images.is_empty() {
            return Err("消息不能为空".into());
        }
        if let Some(session) = self.store.session(session_id).map_err(|e| e.to_string())? {
            let _ = self.session_adapter(&session)?;
        }
        // 和各适配器、子任务回报判断命令的口径一样：不看开头的空白。
        let command = text.trim_start();
        if command.starts_with('/') && images.is_empty() && preface.is_none() {
            let text = command.to_string();
            self.with_writer(session_id, move |handle| {
                let text = text.clone();
                async move { handle.send_message(text).await }
            })
            .await?;
            return Ok(TurnDelivery::Started);
        }
        // 换 Agent 后的第一条消息带上前文。时间线里的用户气泡仍只画用户写的。
        let handoff = self.prepare_handoff(session_id, &text, images.len())?;
        let body = match &preface {
            Some((preface, _)) => format!("{preface}\n\n{text}"),
            None => text.clone(),
        };
        let turn = UserTurn {
            text: handoff.as_ref().map_or_else(|| body.clone(), |handoff| handoff.message(&body)),
            images: images.clone(),
            client_id: new_id(),
            annotations: Vec::new(),
        };
        // 先确保已连接 CLI（若工作树曾被挂起也会在此恢复目录），再捕获 pre_ref 快照；
        // 避免 CLI 启动失败时创建并泄漏未入库的 Git 引用。
        let _ = self.ensure_live(session_id).await?;
        // 仅在会话当前空闲时，于交付回合给 CLI 之前拍下本轮 pre_ref 快照；
        // 回合进行中（排队或中途引导）CLI 可能正在修改文件，绝不伪造“回合开始前”快照。
        let is_idle = self
            .store
            .session(session_id)
            .ok()
            .flatten()
            .is_some_and(|s| !crate::services::session_busy(&s));
        if is_idle {
            self.clear_pending_pre_checkpoint(session_id);
        }
        let pre_checkpoint = if is_idle && sender.is_none() {
            self.capture_pre_checkpoint(session_id).await
        } else {
            None
        };
        let _delivering = self.delivering_of(session_id).lock_owned().await;
        let delivery = match self
            .with_writer(session_id, move |handle| {
                let turn = turn.clone();
                async move {
                    if now {
                        handle.deliver_now(turn).await
                    } else {
                        handle.deliver(turn).await
                    }
                }
            })
            .await
        {
            Ok(delivery) => delivery,
            Err(err) => {
                if let Some(pre) = pre_checkpoint {
                    pre.discard_async().await;
                }
                return Err(err);
            }
        };
        if let Some(handoff) = handoff {
            self.mark_delivered(session_id, handoff)?;
        }
        if delivery == TurnDelivery::Started {
            if let Some((preface, from)) = preface {
                self.record(
                    session_id,
                    SessionEventBody::UserMessage {
                        text: preface,
                        images: Vec::new(),
                        annotations: 0,
                        sender: Some(from),
                    },
                )?;
            }
            let is_plain_user = sender.is_none();
            let pre_for_record = if is_plain_user { pre_checkpoint } else { None };
            let had_pre = pre_for_record.is_some();
            let recorded_id = self.record_with_checkpoint(
                session_id,
                SessionEventBody::UserMessage {
                    text,
                    images,
                    annotations: 0,
                    sender,
                },
                pre_for_record,
            )?;
            if is_plain_user && !had_pre && !is_idle {
                if let Some(ev_id) = recorded_id {
                    if !self.store.is_side_session(session_id).unwrap_or(false) {
                        self.save_unanchored_turn_checkpoint(session_id, &ev_id);
                    }
                }
            }
        } else if let Some(pre) = pre_checkpoint {
            pre.discard_async().await;
        }
        Ok(delivery)
    }

    /// 页面批注：评论当正文，截图当附图。
    pub(crate) async fn submit_annotation(
        self: &Arc<Self>,
        session_id: &str,
        note: PageAnnotation,
    ) -> RuntimeResult<TurnDelivery> {
        if let Some(session) = self.store.session(session_id).map_err(|e| e.to_string())? {
            let _ = self.session_adapter(&session)?;
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
        let _ = self.ensure_live(session_id).await?;
        let should_pre_capture = self
            .store
            .session(session_id)
            .ok()
            .flatten()
            .is_some_and(|s| !crate::services::session_busy(&s));
        if should_pre_capture {
            self.clear_pending_pre_checkpoint(session_id);
        }
        let pre_checkpoint = if should_pre_capture {
            self.capture_pre_checkpoint(session_id).await
        } else {
            None
        };
        let _delivering = self.delivering_of(session_id).lock_owned().await;
        let delivery = match self
            .with_writer(session_id, move |handle| {
                let note = note.clone();
                async move { handle.submit_annotation(note).await }
            })
            .await
        {
            Ok(delivery) => delivery,
            Err(err) => {
                if let Some(pre) = pre_checkpoint {
                    pre.discard_async().await;
                }
                return Err(err);
            }
        };
        if delivery == TurnDelivery::Started {
            let had_pre = pre_checkpoint.is_some();
            let recorded_id = self.record_with_checkpoint(
                session_id,
                SessionEventBody::UserMessage {
                    text: comment,
                    images,
                    annotations: 1,
                    sender: None,
                },
                pre_checkpoint,
            )?;
            if !had_pre && !should_pre_capture {
                if let Some(ev_id) = recorded_id {
                    if !self.store.is_side_session(session_id).unwrap_or(false) {
                        self.save_unanchored_turn_checkpoint(session_id, &ev_id);
                    }
                }
            }
        } else if let Some(pre) = pre_checkpoint {
            pre.discard_async().await;
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
        let goal = objective.clone();
        self.with_writer(session_id, move |handle| {
            let goal = goal.clone();
            async move { handle.set_goal(&goal).await }
        })
        .await?;
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
                sender: None,
            },
        )
    }

    pub(crate) async fn interrupt(self: &Arc<Self>, session_id: &str) -> RuntimeResult<()> {
        if self.cancel_initial(session_id) {
            self.record(session_id, SessionEventBody::StatusChanged { status: SessionStatus::Stopped })?;
            self.stop(session_id).await;
            return Ok(());
        }
        let Some(handle) = self.live_handle(session_id) else {
            // 若会话不在首轮启动、也不在重连中且已无存活句柄，但库里仍残留运行态，同步收敛为已停止。
            if !self.starting.lock().unwrap().contains_key(session_id) {
                if let Ok(_opening) = self.opening_of(session_id).try_lock() {
                    if !self.is_live(session_id) {
                        self.settle_stopped_session(session_id)?;
                    }
                }
            }
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
        let cancelled = self.cancel_initial(session_id);
        if cancelled && self.store.session(session_id).ok().flatten().is_some_and(|s| s.status != SessionStatus::Stopped) {
            let _ = self.record(session_id, SessionEventBody::StatusChanged { status: SessionStatus::Stopped });
        }
        self.mcp.revoke(session_id);
        let entry = self.live.lock().unwrap().remove(session_id);
        if let Some(entry) = entry {
            if cancelled || self.initial_cancelled(session_id) {
                entry.muted.store(true, Ordering::SeqCst);
            }
            let _ = entry.handle.stop().await;
        } else if !cancelled && !self.starting.lock().unwrap().contains_key(session_id) {
            if let Ok(_opening) = self.opening_of(session_id).try_lock() {
                if !self.is_live(session_id) {
                    let _ = self.settle_stopped_session(session_id);
                }
            }
        }
    }

    /// 静音并停掉会话 CLI：持有 `opening` 锁防止并发 `ensure_live` 插回新句柄，
    /// 在 `handle.stop()` 前置 `muted = true` 并清空压着的流式 `held`，确保关进程尾事件绝不写回时间线。
    pub async fn stop_and_mute(&self, session_id: &str) {
        self.clear_pending_pre_checkpoint(session_id);
        let _ = self.cancel_initial(session_id);
        let _opening = self.opening_of(session_id).lock_owned().await;
        self.mcp.revoke(session_id);
        let entry = self.live.lock().unwrap().remove(session_id);
        if let Some(entry) = entry {
            entry.muted.store(true, Ordering::SeqCst);
            *entry.held.lock().unwrap() = None;
            let _ = entry.handle.stop().await;
        }
    }

    /// 已完成、空闲超过 `idle_ms`、没人在看、没有排队、能 resume 的会话：关掉 CLI，丢掉时间线副本。
    /// 关之前先静音，适配器关进程时报的状态不进时间线，会话仍是已完成。下次用到时 `ensure_live` 接回。
    /// 侧边聊天接不回去：哪条连接的面板里都没有它的标签时，已完成、空闲、没有排队就直接关掉
    /// （界面关了或重载后标签没了）。有标签时窗口没焦点、在看别的任务也留着。
    pub(crate) async fn release_idle(&self, now: i64, idle_ms: i64) -> RuntimeResult<usize> {
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
            // 正在接的会话不动。拿着它的锁，关的时候不会有人同时接。
            let opening = self.opening_of(&session_id);
            let Ok(_opening) = opening.try_lock() else {
                continue;
            };
            let Some(session) = self.store.session(&session_id).map_err(|e| e.to_string())? else {
                continue;
            };
            if session.status != SessionStatus::Completed {
                continue;
            }
            // 主回合完了，后台的子 Agent 或后台任务还在跑。关掉进程会把它们一起停掉。
            let working = self
                .store
                .attention(&session_id)
                .map_err(|e| e.to_string())?
                .is_some_and(|attention| attention.state == AttentionState::Working);
            if working {
                continue;
            }
            if self.store.is_side_session(&session_id).map_err(|e| e.to_string())? {
                if self.has_side_tab(&session_id) {
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
            if !self.pending_prompt_ids(&session_id)?.is_empty() {
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
                self.mcp.revoke(&session_id);
                entry.muted.store(true, Ordering::SeqCst);
                logs.remove(&session_id);
                entry
            };
            let _ = entry.handle.stop().await;
            released += 1;
        }
        self.drop_detached_logs();
        // 没人拿着也没人等的锁不留，再用到时新建。
        self.opening.lock().unwrap().retain(|_, lock| Arc::strong_count(lock) > 1);
        self.delivering
            .lock()
            .unwrap()
            .retain(|_, lock| Arc::strong_count(lock) > 1);
        Ok(released)
    }

    /// 没接着 CLI、也没有排队的会话，时间线副本不留；再用到时从库里读。
    fn drop_detached_logs(&self) {
        let mut logs = self.logs.lock().unwrap();
        let live = self.live.lock().unwrap();
        logs.retain(|session_id, log| live.contains_key(session_id) || !log.queue.is_empty());
    }

    /// 不建线程起一次 CLI，只要模型目录，拿到就关掉。
    async fn probe_catalog_for(
        &self,
        agent: AgentKind,
        instance_id: Option<&str>,
        cwd: String,
    ) -> RuntimeResult<AgentCatalog> {
        let key = catalogs::instance_key(agent, instance_id);
        let ctx = SessionContext {
            project_path: cwd,
            access_mode: None,
            resume_native_id: None,
            workbench_mcp: None,
            options: json!({}),
        };
        let (tx, _rx) = mpsc::unbounded_channel();
        let handle = self
            .adapter_for_instance(agent, Some(&key))?
            .start_session(ctx, tx)
            .await
            .map_err(|e| e.to_string())?;
        self.probe_handles
            .lock()
            .unwrap()
            .insert(key.clone(), handle.clone());
        // 起 CLI 的工夫里开始退出了：`stop_all` 可能已经扫过，这里自己关。
        let catalog = if self.closing.load(Ordering::SeqCst) {
            Err("后台正在退出".to_string())
        } else {
            handle.catalog().await.map_err(|e| e.to_string())
        };
        self.probe_handles.lock().unwrap().remove(&key);
        let _ = handle.stop().await;
        catalog
    }

    fn capture_post_checkpoint_bg(&self, session_id: &str, task_id: &str) {
        let Ok(mut cps) = self.store.session_checkpoints(session_id) else {
            return;
        };
        let Some(cp) = cps.pop().filter(|c| c.post_ref.is_none()) else {
            return;
        };
        let Ok(cwd_str) = self.workdir_of_task(task_id) else {
            return;
        };
        let sid = session_id.to_string();
        let store = Arc::clone(&self.store);
        let work = move || {
            let cwd = std::path::PathBuf::from(cwd_str);
            if let Ok(Some(cap)) = aiwb_git::capture_checkpoint(&cwd, &sid, &cp.id, "post") {
                if !store
                    .update_checkpoint_post(&cp.id, Some(&cap.reference), now_millis())
                    .unwrap_or(false)
                {
                    aiwb_git::delete_checkpoint_refs(&cwd, &[cap.reference]);
                }
            }
        };
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn_blocking(work);
        } else {
            work();
        }
    }

    /// 记录一条不含 `pre_ref` 的检查点占位行（例如原生队列自动发出的回合或回合中引导）：
    /// 绝不在适配器确认消息已发出后才后台补拍“回合开始前”快照（避免把本轮已修改的文件混入 pre_ref），
    /// 同时保留该轮的 `turn_id` 与回合结束后的 `post_ref` 追踪，避免误报前置轮次的手动改动警告。
    fn save_unanchored_turn_checkpoint(&self, session_id: &str, user_event_id: &str) {
        if self
            .store
            .checkpoint_for_user_event(session_id, user_event_id)
            .ok()
            .flatten()
            .is_some()
        {
            return;
        }
        let (task_id, cut_seq, turn_id) = {
            let mut logs = self.logs.lock().unwrap();
            let Ok(log) = self.log_mut(&mut logs, session_id) else {
                return;
            };
            let Some(idx) = log.events.iter().rposition(|e| e.id == user_event_id) else {
                return;
            };
            let (cut_seq, turn_id) =
                crate::services::checkpoints::compute_turn_cut_seq(&log.events, idx);
            (log.task_id.clone(), cut_seq, turn_id)
        };
        let Ok(cwd_str) = self.workdir_of_task(&task_id) else {
            return;
        };
        let now = now_millis();
        let cp = aiwb_core::checkpoint::TurnCheckpoint {
            id: new_id(),
            task_id,
            session_id: session_id.to_string(),
            user_event_id: user_event_id.to_string(),
            cut_seq,
            turn_id,
            pre_ref: None,
            post_ref: None,
            head_oid: None,
            branch: None,
            cwd: cwd_str,
            created_at: now,
            updated_at: now,
        };
        let _ = self.store.put_checkpoint(&cp);
    }

    pub(crate) async fn stop_all(&self) {
        self.closing.store(true, Ordering::SeqCst);
        let probes: Vec<_> = self.probe_handles.lock().unwrap().drain().map(|(_, handle)| handle).collect();
        let handles: Vec<_> = self
            .live
            .lock()
            .unwrap()
            .drain()
            .map(|(id, entry)| {
                self.mcp.revoke(&id);
                entry.handle
            })
            .chain(probes)
            .collect();
        for handle in handles {
            let _ = handle.stop().await;
        }
    }

    pub(crate) fn is_live(&self, session_id: &str) -> bool {
        self.live.lock().unwrap().contains_key(session_id)
    }
}

/// 同一条流的全文覆盖最密隔这么久写一次。照 Codex 适配器自己的节流（`codex/rpc.rs`）。
const STREAM_INTERVAL: std::time::Duration = std::time::Duration::from_millis(80);

/// 带 `stream_id` 的助手消息或思考：每次都是全文，后一条盖掉前一条。
fn is_stream_overwrite(body: &SessionEventBody) -> bool {
    matches!(
        body,
        SessionEventBody::AgentMessage { stream_id: Some(_), .. } | SessionEventBody::Thinking { stream_id: Some(_), .. }
    )
}

/// `next` 和 `earlier` 是同一条流时并成一条，结果和先后各写一次一样：正文用新的，
/// 阶段、模式、去重标记只在新值有内容时换（同 `aiwb_core::timeline` 的归并）。不是同一条流就原样还回来。
fn absorb_stream(
    earlier: SessionEventBody,
    next: SessionEventBody,
) -> Result<SessionEventBody, Box<(SessionEventBody, SessionEventBody)>> {
    match (earlier, next) {
        (
            SessionEventBody::AgentMessage { stream_id: Some(id), phase, mode, dedupe_of, .. },
            SessionEventBody::AgentMessage {
                text,
                stream_id: Some(next_id),
                phase: next_phase,
                mode: next_mode,
                dedupe_of: next_dedupe,
            },
        ) if id == next_id => Ok(SessionEventBody::AgentMessage {
            text,
            stream_id: Some(id),
            phase: next_phase.or(phase),
            mode: next_mode.or(mode),
            dedupe_of: next_dedupe.or(dedupe_of),
        }),
        (
            SessionEventBody::Thinking { stream_id: Some(id), .. },
            SessionEventBody::Thinking { text, stream_id: Some(next_id) },
        ) if id == next_id => Ok(SessionEventBody::Thinking { text, stream_id: Some(id) }),
        (earlier, next) => Err(Box::new((earlier, next))),
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
            parent_task_id: None,
        };
        let session = TaskSession {
            id: "s".into(),
            task_id: "t".into(),
            agent: AgentKind::ClaudeCode,
            instance_id: None,
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
    fn restart_stops_starting_sessions_without_losing_the_accepted_message() {
        let (store, runtimes) = runtimes_with_task(SessionStatus::Starting);
        runtimes.record("s", SessionEventBody::UserMessage {
            text: "accepted before launch".into(), images: vec![], annotations: 0, sender: None,
        }).unwrap();
        let first = store.events_since("s", 0).unwrap()[0].event.clone();
        // A new runtime has no in-memory startup state.
        let restarted = Runtimes::new(store.clone(), Arc::new(Hub::new()), Arc::new(aiwb_agents::adapter_for));
        restarted.settle_interrupted().unwrap();
        assert_eq!(store.session("s").unwrap().unwrap().status, SessionStatus::Stopped);
        assert_eq!(store.attention("s").unwrap().unwrap().state, AttentionState::Idle);
        assert_eq!(store.events_since("s", 0).unwrap()[0].event.id, first.id);
        assert_eq!(store.events_since("s", 0).unwrap().len(), 2);
    }

    /// 主回合被打断后后台命令还在跑，daemon 没等到它结束就退出了：重启时也要记成已停止，
    /// 不然同一会话以后完成新回合时，旧任务会让侧栏一直算在做。
    #[test]
    fn restart_stops_background_tasks_of_stopped_sessions() {
        use aiwb_core::models::{BackgroundTask, BackgroundTaskStatus};
        let (store, runtimes) = runtimes_with_task(SessionStatus::Completed);
        runtimes.record("s", status(SessionStatus::Running)).unwrap();
        runtimes.record("s", SessionEventBody::BackgroundTask(BackgroundTask::new("b1", "local_bash", "sleep"))).unwrap();
        runtimes.record("s", status(SessionStatus::Stopped)).unwrap();
        assert_eq!(store.attention("s").unwrap().unwrap().state, AttentionState::Idle);

        let restarted = Runtimes::new(store.clone(), Arc::new(Hub::new()), Arc::new(aiwb_agents::adapter_for));
        restarted.settle_interrupted().unwrap();
        let tasks: Vec<BackgroundTask> = store
            .events_since("s", 0)
            .unwrap()
            .into_iter()
            .filter_map(|stored| match stored.event.body {
                SessionEventBody::BackgroundTask(task) => Some(task),
                _ => None,
            })
            .collect();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].status, BackgroundTaskStatus::Stopped);
        assert!(store.sessions_with_running_background().unwrap().is_empty());

        // 同一会话再完成一轮：没有遗留的后台任务，算完成。
        restarted.record("s", status(SessionStatus::Running)).unwrap();
        restarted.record("s", status(SessionStatus::Completed)).unwrap();
        assert_eq!(store.attention("s").unwrap().unwrap().state, AttentionState::Done);
    }

    /// 主回合完了后台命令还在跑，daemon 就退出了。重启时把命令记成停止，会话因此算完成，但这不是回合做完了：
    /// 不能给父任务报「完成」，不然父任务空闲时会被叫醒开新一轮。
    #[test]
    fn restart_cleanup_does_not_report_the_turn_as_completed() {
        use aiwb_core::models::BackgroundTask;
        let (store, runtimes) = runtimes_with_task(SessionStatus::Completed);
        runtimes.record("s", status(SessionStatus::Running)).unwrap();
        runtimes.record("s", SessionEventBody::BackgroundTask(BackgroundTask::new("b1", "terminal", "sleep"))).unwrap();
        runtimes.record("s", status(SessionStatus::Completed)).unwrap();
        assert_eq!(store.attention("s").unwrap().unwrap().state, AttentionState::Working);

        let restarted = Runtimes::new(store.clone(), Arc::new(Hub::new()), Arc::new(aiwb_agents::adapter_for));
        let mut notes = restarted.take_status_notes().unwrap();
        restarted.settle_interrupted().unwrap();
        assert_eq!(store.attention("s").unwrap().unwrap().state, AttentionState::Done);
        assert!(notes.try_recv().is_err(), "重启收拾不回报父任务");

        // 收拾完以后照常回报。
        restarted.record("s", status(SessionStatus::Running)).unwrap();
        restarted.record("s", status(SessionStatus::Completed)).unwrap();
        let mut seen = Vec::new();
        while let Ok(note) = notes.try_recv() {
            seen.push(note.status);
        }
        assert_eq!(seen, [SessionStatus::Running, SessionStatus::Completed]);
    }

    /// 主回合完了后台任务还在跑，不报状态；最后一个后台任务跑完、会话变成完成时才报，子任务回报靠它。
    #[test]
    fn last_background_task_finishing_reports_the_turn_end() {
        use aiwb_core::models::{BackgroundTask, BackgroundTaskStatus};
        let (_store, runtimes) = runtimes_with_task(SessionStatus::Completed);
        let mut notes = runtimes.take_status_notes().unwrap();
        runtimes.record("s", status(SessionStatus::Running)).unwrap();
        let mut task = BackgroundTask::new("b1", "terminal", "sleep");
        runtimes.record("s", SessionEventBody::BackgroundTask(task.clone())).unwrap();
        runtimes.record("s", status(SessionStatus::Completed)).unwrap();
        let mut seen = Vec::new();
        while let Ok(note) = notes.try_recv() {
            seen.push(note.status);
        }
        assert_eq!(seen, [SessionStatus::Running]);

        task.finish(BackgroundTaskStatus::Completed, Some(2));
        runtimes.record("s", SessionEventBody::BackgroundTask(task)).unwrap();
        let note = notes.try_recv().expect("后台任务跑完要报完成");
        assert_eq!((note.task_id.as_str(), note.status), ("t", SessionStatus::Completed));
        assert!(notes.try_recv().is_err());
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
        sent: Mutex<Vec<String>>,
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
        async fn send_message(&self, text: String) -> Result<(), AgentError> {
            self.sent.lock().unwrap().push(text);
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
        let held = Held::default();
        runtimes.spawn_pump("s".into(), rx, muted.clone(), used.clone(), held.clone());
        let session = Arc::new(QuietlyStopped {
            sink: tx,
            stopped: Default::default(),
            sent: Default::default(),
        });
        runtimes.live.lock().unwrap().insert(
            "s".into(),
            Live {
                handle: session.clone(),
                muted,
                used_at: used,
                held,
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

    #[tokio::test]
    async fn forgetting_a_dead_handle_keeps_the_one_that_replaced_it() {
        let (_store, runtimes) = resumable_runtimes();
        attach(&runtimes, 0);
        let dead = runtimes.live_handle("s").unwrap();
        // 另一个调用已经重新接上。
        attach(&runtimes, 0);
        let fresh = runtimes.live_handle("s").unwrap();
        runtimes.forget("s", &dead);
        assert!(Arc::ptr_eq(&runtimes.live_handle("s").unwrap(), &fresh));
        runtimes.forget("s", &fresh);
        assert!(!runtimes.is_live("s"));
    }

    fn delta(stream: &str, text: &str) -> SessionEventBody {
        SessionEventBody::AgentMessage {
            text: text.into(),
            stream_id: Some(stream.into()),
            phase: None,
            mode: None,
            dedupe_of: None,
        }
    }

    fn texts(store: &Store) -> Vec<String> {
        store
            .events_since("s", 0)
            .unwrap()
            .into_iter()
            .map(|item| match item.event.body {
                SessionEventBody::AgentMessage { text, .. }
                | SessionEventBody::Thinking { text, .. }
                | SessionEventBody::System { text }
                | SessionEventBody::UserMessage { text, .. } => text,
                SessionEventBody::StatusChanged { status } => format!("{status:?}"),
                other => format!("{other:?}"),
            })
            .collect()
    }

    /// 让 pump 把收到的处理完，时钟只往前走 1ms（不到节流间隔）。
    async fn settle() {
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_directly_recorded_event_does_not_overtake_held_stream_text() {
        let (store, runtimes) = resumable_runtimes();
        let session = attach(&runtimes, 0);
        session.sink.send(delta("m1", "第一条")).unwrap();
        // 新的一条流紧跟着来，被压住。
        session.sink.send(delta("m2", "第二条")).unwrap();
        settle().await;
        assert_eq!(texts(&store), ["第一条"]);
        runtimes.record("s", SessionEventBody::System { text: "直接记的".into() }).unwrap();
        assert_eq!(texts(&store), ["第一条", "第二条", "直接记的"]);
        // 压着的已经写过，到点不再写一遍。
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(store.events_since("s", 0).unwrap().iter().map(|item| item.rev).max(), Some(3));
    }

    #[tokio::test(start_paused = true)]
    async fn the_full_text_lands_before_the_turn_ends_and_before_the_channel_closes() {
        let (store, runtimes) = resumable_runtimes();
        let session = attach(&runtimes, 0);
        let thinking = |text: &str| SessionEventBody::Thinking { text: text.into(), stream_id: Some("t1".into()) };
        session.sink.send(status(SessionStatus::Running)).unwrap();
        session.sink.send(thinking("想")).unwrap();
        session.sink.send(thinking("想好了")).unwrap();
        session.sink.send(delta("m1", "答")).unwrap();
        session.sink.send(delta("m1", "答完了")).unwrap();
        session.sink.send(status(SessionStatus::Completed)).unwrap();
        settle().await;
        assert_eq!(texts(&store), ["Running", "想好了", "答完了", "Completed"]);
        assert_eq!(store.attention("s").unwrap().unwrap().preview.as_deref(), Some("答完了"));

        // 进程退出、通道关掉时，压着的最后一段也写出去。
        session.sink.send(delta("m2", "收尾")).unwrap();
        session.sink.send(delta("m2", "收尾了")).unwrap();
        runtimes.live.lock().unwrap().remove("s");
        drop(session);
        settle().await;
        assert_eq!(texts(&store).last().map(String::as_str), Some("收尾了"));
    }

    #[tokio::test(start_paused = true)]
    async fn held_stream_text_of_a_muted_session_is_dropped() {
        let (store, runtimes) = resumable_runtimes();
        let session = attach(&runtimes, 0);
        session.sink.send(delta("m1", "写了")).unwrap();
        session.sink.send(delta("m2", "压着")).unwrap();
        settle().await;
        runtimes.live.lock().unwrap().get("s").unwrap().muted.store(true, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(texts(&store), ["写了"]);
    }

    #[tokio::test(start_paused = true)]
    async fn stop_and_mute_waits_for_opening_clears_held_and_suppresses_exit_events() {
        let (store, runtimes) = resumable_runtimes();
        let opening = runtimes.opening_of("s").lock_owned().await;
        let stopping = {
            let runtimes = runtimes.clone();
            tokio::spawn(async move { runtimes.stop_and_mute("s").await })
        };
        settle().await;
        assert!(!stopping.is_finished(), "must wait on opening_of lock");

        let session = attach(&runtimes, 0);
        session.sink.send(delta("m1", "已落库")).unwrap();
        session.sink.send(delta("m1", "压在held里")).unwrap();
        settle().await;
        assert_eq!(texts(&store), ["已落库"]);

        drop(opening);
        stopping.await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        assert_eq!(session.stopped.load(Ordering::SeqCst), 1);
        assert!(!runtimes.is_live("s"));
        // QuietlyStopped::stop 发送的 Stopped 和 held 里的覆盖均被静音丢弃，不污染回退后的时间线。
        assert_eq!(texts(&store), ["已落库"]);
        assert_eq!(store.session("s").unwrap().unwrap().status, SessionStatus::Completed);
    }

    #[tokio::test]
    async fn a_session_being_opened_is_not_released_and_unused_locks_are_dropped() {
        let (_store, runtimes) = resumable_runtimes();
        attach(&runtimes, 0);
        let opening = runtimes.opening_of("s").lock_owned().await;
        assert_eq!(runtimes.release_idle(30 * MIN, 30 * MIN).await.unwrap(), 0);
        assert!(runtimes.is_live("s"));
        assert!(runtimes.opening.lock().unwrap().contains_key("s"), "有人拿着的锁留着");
        drop(opening);
        assert_eq!(runtimes.release_idle(30 * MIN, 30 * MIN).await.unwrap(), 1);
        assert!(runtimes.opening.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn discarding_waits_for_the_session_to_finish_opening() {
        let (_store, runtimes) = resumable_runtimes();
        let opening = runtimes.opening_of("s").lock_owned().await;
        let discarding = {
            let runtimes = runtimes.clone();
            tokio::spawn(async move { runtimes.discard("s").await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!discarding.is_finished());
        // 这时接上的 CLI，丢弃时一起停掉。
        let session = attach(&runtimes, 0);
        drop(opening);
        discarding.await.unwrap();
        assert_eq!(session.stopped.load(Ordering::SeqCst), 1);
        assert!(!runtimes.is_live("s"));
    }

    #[tokio::test]
    async fn timeline_copies_of_detached_sessions_are_dropped_on_the_idle_sweep() {
        let (_store, runtimes) = resumable_runtimes();
        runtimes.record("s", SessionEventBody::System { text: "一".into() }).unwrap();
        assert!(runtimes.logs.lock().unwrap().contains_key("s"));
        assert_eq!(runtimes.release_idle(30 * MIN, 30 * MIN).await.unwrap(), 0);
        assert!(!runtimes.logs.lock().unwrap().contains_key("s"));

        // 接着 CLI 的、还有排队的留着。
        attach(&runtimes, 30 * MIN);
        runtimes.record("s", SessionEventBody::System { text: "二".into() }).unwrap();
        assert_eq!(runtimes.release_idle(30 * MIN, 30 * MIN).await.unwrap(), 0);
        assert!(runtimes.logs.lock().unwrap().contains_key("s"));
    }

    #[tokio::test]
    async fn a_command_with_leading_whitespace_is_sent_as_a_command() {
        let (store, runtimes) = resumable_runtimes();
        let session = attach(&runtimes, 0);
        let delivery = runtimes
            .send_message("s", Outgoing::user("  /status".into(), Vec::new(), false))
            .await
            .unwrap();
        assert_eq!(delivery, TurnDelivery::Started);
        assert_eq!(*session.sent.lock().unwrap(), ["/status"]);
        assert!(store.events_since("s", 0).unwrap().is_empty(), "命令不画用户气泡");
    }

    #[tokio::test]
    async fn a_copy_that_could_not_be_reread_is_reread_before_its_next_use() {
        let (store, runtimes) = resumable_runtimes();
        runtimes.record("s", SessionEventBody::System { text: "一".into() }).unwrap();
        {
            let mut logs = runtimes.logs.lock().unwrap();
            let log = logs.get_mut("s").unwrap();
            log.events.clear();
            log.queue.push(QueuedTurn { id: "q".into(), text: "下一条".into(), images: Vec::new(), client_id: String::new() });
            log.stale = true;
        }
        runtimes.record("s", SessionEventBody::System { text: "二".into() }).unwrap();
        assert_eq!(texts(&store), ["一", "二"]);
        let logs = runtimes.logs.lock().unwrap();
        assert_eq!(logs["s"].events.len(), 2);
        assert_eq!(logs["s"].queue.len(), 1, "排队留着");
    }

    #[tokio::test(start_paused = true)]
    async fn dense_stream_overwrites_are_written_sparsely_and_end_on_the_latest_text() {
        let (store, runtimes) = resumable_runtimes();
        let session = attach(&runtimes, 0);
        let delta = |text: String| SessionEventBody::AgentMessage {
            text,
            stream_id: Some("m1".into()),
            phase: None,
            mode: None,
            dedupe_of: None,
        };
        for index in 0..200 {
            session.sink.send(delta(format!("第 {index} 段"))).unwrap();
        }
        // 别的事件一到，压着的那条先写。
        session.sink.send(SessionEventBody::System { text: "之后".into() }).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let events = store.events_since("s", 0).unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0].event.body, SessionEventBody::AgentMessage { text, .. } if text == "第 199 段"));
        assert!(matches!(&events[1].event.body, SessionEventBody::System { .. }));
        assert_eq!(events[1].rev, 3, "200 次覆盖只写了头一次和最后的全文");

        // 没有后续事件时，压着的那条到点自己写出去。
        session.sink.send(delta("第 200 段".into())).unwrap();
        session.sink.send(delta("最后".into())).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let events = store.events_since("s", 0).unwrap();
        assert!(matches!(&events[0].event.body, SessionEventBody::AgentMessage { text, .. } if text == "最后"));
    }

    #[test]
    fn a_failed_write_leaves_the_copy_matching_the_database() {
        let (store, runtimes) = runtimes_with_task(SessionStatus::Completed);
        runtimes.record("s", SessionEventBody::System { text: "一".into() }).unwrap();
        // 会话行没了，外键挡住写入。
        store.remove_session("s").unwrap();
        assert!(runtimes.record("s", SessionEventBody::System { text: "二".into() }).is_err());
        let logs = runtimes.logs.lock().unwrap();
        let log = logs.get("s").unwrap();
        assert!(log.events.is_empty());
        assert_eq!((log.next_seq, log.next_rev), (1, 1));
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
        runtimes.set_side_tabs(1, vec!["s".into()]);
        assert_eq!(runtimes.release_idle(30 * MIN, 30 * MIN).await.unwrap(), 0);
        assert!(!store.task_side_sessions("t").unwrap().is_empty());

        // 那条连接关了标签（或断开）：接不回去，直接关掉；有人看着这个任务也一样。
        runtimes.set_side_tabs(1, Vec::new());
        runtimes.set_viewing(2, Some("t".into())).unwrap();
        assert_eq!(runtimes.release_idle(30 * MIN, 30 * MIN).await.unwrap(), 1);
        assert!(store.task_side_sessions("t").unwrap().is_empty());
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
            parent_task_id: None,
        };
        let session = TaskSession {
            id: "s".into(),
            task_id: "t".into(),
            agent: AgentKind::ClaudeCode,
            instance_id: None,
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

    /// 每次启动都失败的 Agent。`gone` 时报原生会话没了，否则报一句协议原文。
    struct FailingStart {
        gone: bool,
        starts: std::sync::atomic::AtomicUsize,
        options: Mutex<Vec<Value>>,
    }

    #[async_trait::async_trait]
    impl AgentAdapter for FailingStart {
        fn kind(&self) -> AgentKind {
            AgentKind::Antigravity
        }

        fn capabilities(&self) -> aiwb_core::models::AgentCapabilities {
            aiwb_core::models::AgentCapabilities::antigravity()
        }

        async fn detect(&self) -> Result<(), AgentError> {
            Ok(())
        }

        async fn start_session(
            &self,
            ctx: SessionContext,
            _events: aiwb_agents::EventSink,
        ) -> Result<Arc<dyn AgentSession>, AgentError> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            self.options.lock().unwrap().push(ctx.options);
            Err(if self.gone {
                AgentError::SessionGone
            } else {
                AgentError::Runtime("session/resume 失败：Failed to read session".into())
            })
        }
    }

    fn failing_runtimes(store: &Arc<Store>, adapter: &Arc<FailingStart>) -> Arc<Runtimes> {
        let adapter = adapter.clone();
        Arc::new(Runtimes::new(store.clone(), Arc::new(Hub::new()), Arc::new(move |_| adapter.clone())))
    }

    fn errors(store: &Store) -> Vec<String> {
        store
            .events_since("s", 0)
            .unwrap()
            .into_iter()
            .filter_map(|item| match item.event.body {
                SessionEventBody::Error { message } => Some(message),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn reopened_sessions_receive_the_latest_persisted_goal_including_clear() {
        let (store, runtimes) = runtimes_with_task(SessionStatus::Completed);
        store.set_session_native_id("s", "thread-1").unwrap();
        let adapter = Arc::new(FailingStart { gone: false, starts: Default::default(), options: Default::default() });
        let goal = |objective: Option<&str>| SessionEventBody::Goal {
            objective: objective.map(str::to_string), status: Some("paused".into()),
            token_budget: None, tokens_used: None, time_used_seconds: None,
        };
        for objective in [Some("old goal"), Some("new goal"), None] {
            let event = goal(objective);
            runtimes.record("s", event.clone()).unwrap();
            // 新的 runtime 没有内存中的时间线，必须从 SQLite 读回来。
            let restarted = failing_runtimes(&store, &adapter);
            let _ = restarted.handle("s").await;
            let options = adapter.options.lock().unwrap().last().unwrap().clone();
            assert_eq!(options["saved_goal"], serde_json::to_value(event).unwrap());
        }
        // 没有原生会话时不能把抄来的目标当作恢复状态。
        store.set_session_native_id("s", "").unwrap();
        let _ = failing_runtimes(&store, &adapter).handle("s").await;
        assert!(adapter.options.lock().unwrap().last().unwrap().get("saved_goal").is_none());
    }

    #[tokio::test]
    async fn repeated_startup_failure_is_recorded_once() {
        let (store, _) = runtimes_with_task(SessionStatus::Completed);
        store.set_session_native_id("s", "thread-1").unwrap();
        let adapter = Arc::new(FailingStart { gone: false, starts: Default::default(), options: Default::default() });
        let runtimes = failing_runtimes(&store, &adapter);
        // 打开会话时目录、权限菜单、目标各自要句柄。
        for _ in 0..4 {
            assert!(runtimes.handle("s").await.is_err());
        }
        assert_eq!(adapter.starts.load(Ordering::SeqCst), 4, "不确定的失败下次还要再试");
        assert_eq!(errors(&store).len(), 1);
        assert_eq!(store.session("s").unwrap().unwrap().status, SessionStatus::Failed);

        // 重启 daemon 后再打开，还是那一条。
        let restarted = failing_runtimes(&store, &adapter);
        assert!(restarted.handle("s").await.is_err());
        assert_eq!(errors(&store).len(), 1);

        // 中间有过别的事，再失败要再记。
        restarted.record("s", SessionEventBody::UserMessage {
            text: "再试一次".into(), images: vec![], annotations: 0, sender: None,
        }).unwrap();
        assert!(restarted.handle("s").await.is_err());
        assert_eq!(errors(&store).len(), 2);
    }

    #[tokio::test]
    async fn gone_native_session_is_reported_once_without_restarting_the_cli() {
        let (store, _) = runtimes_with_task(SessionStatus::Completed);
        store.set_session_native_id("s", "thread-1").unwrap();
        let adapter = Arc::new(FailingStart { gone: true, starts: Default::default(), options: Default::default() });
        let runtimes = failing_runtimes(&store, &adapter);
        for _ in 0..4 {
            assert_eq!(runtimes.handle("s").await.err().as_deref(), Some(AgentError::SessionGone.to_string().as_str()));
        }
        assert_eq!(adapter.starts.load(Ordering::SeqCst), 1);
        assert_eq!(errors(&store), vec![AgentError::SessionGone.to_string()]);

        // 换了原生会话就重新试。
        store.set_session_native_id("s", "thread-2").unwrap();
        assert!(runtimes.handle("s").await.is_err());
        assert_eq!(adapter.starts.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn reopening_says_whether_the_native_session_should_have_history() {
        let (store, _) = runtimes_with_task(SessionStatus::Completed);
        store.set_session_native_id("s", "thread-1").unwrap();
        let adapter = Arc::new(FailingStart { gone: false, starts: Default::default(), options: Default::default() });
        let has_history = |runtimes: &Arc<Runtimes>| {
            let runtimes = runtimes.clone();
            let adapter = adapter.clone();
            async move {
                let _ = runtimes.handle("s").await;
                adapter.options.lock().unwrap().last().unwrap().get("has_history").cloned()
            }
        };
        let reply = || SessionEventBody::AgentMessage {
            text: "好的".into(),
            stream_id: None,
            phase: None,
            mode: None,
            dedupe_of: None,
        };
        let ask = || SessionEventBody::UserMessage { text: "你好".into(), images: vec![], annotations: 0, sender: None };

        // 没聊过的会话，原生那边本来就可能还没有文件。
        assert_eq!(has_history(&failing_runtimes(&store, &adapter)).await, None);

        // 有问有答才算原生会话里有对话。
        let runtimes = failing_runtimes(&store, &adapter);
        runtimes.record("s", ask()).unwrap();
        assert_eq!(has_history(&runtimes).await, None, "只有提问，Agent 可能还没写下文件");
        runtimes.record("s", reply()).unwrap();
        assert_eq!(has_history(&runtimes).await, Some(json!(true)));

        // 分叉、换 Agent 抄来了前文，第一条消息发出去之前原生会话是空的。
        runtimes
            .record(
                "s",
                SessionEventBody::Handoff {
                    from_agent: AgentKind::CodexCli,
                    from_model: None,
                    to_agent: AgentKind::Antigravity,
                    to_model: None,
                    strategy: aiwb_core::models::HandoffStrategy::Full,
                    delivered: false,
                    selected: 0,
                    omitted: 0,
                },
            )
            .unwrap();
        assert_eq!(has_history(&runtimes).await, None);
    }
}
