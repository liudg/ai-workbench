//! 子进程的 stdin/stdout 循环。
//!
//! `initialize` 必须是第一条控制请求（`cli/print.ts`：第一条 user 消息会把会话标成已初始化，
//! 但不会注册 SDK 工具，ExitPlanMode / AskUserQuestion 就不会出现）。
//! stdout 读取不在 `can_use_tool` 上等待；回复由 `answer_prompt` 稍后写回。
//! 历史在 initialize 成功之后、`start_session` 返回之前写入通道，会话管理器用 `try_recv` 装上。
//! `options.skip_history` 时宿主已经有时间线，只读转录记下状态，不写进通道。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot};

use super::catalog;
use super::command::{self, Launch};
use super::control::{self, PermissionKind};
use super::history;
use super::messages::{self, ControlIn, MapState};
use super::process;
use aiwb_proc::decode_child_bytes;
use crate::{AgentError, EventSink};
use aiwb_core::models::{AgentCatalog, PromptAnswer, SessionEventBody, SessionStatus};

const STDERR_CAP: usize = 4000;

enum Intent {
    SetModel(String),
    SetEffort(String),
    SetPermission(String),
    ContextUsage,
    Interrupt,
}

struct PendingLines {
    ready: bool,
    lines: Vec<String>,
}

pub struct Shared {
    pub events: EventSink,
    pub session_id: String,
    pub project_path: PathBuf,
    outbound: Mutex<Option<mpsc::UnboundedSender<String>>>,
    child: Mutex<Option<Child>>,
    pub(super) closed: AtomicBool,
    counter: AtomicU64,
    waiters: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    intents: Mutex<HashMap<String, Intent>>,
    pub(super) prompts: Mutex<HashMap<String, PermissionKind>>,
    pub catalog: Mutex<AgentCatalog>,
    goal: Mutex<Option<SessionEventBody>>,
    map: Mutex<MapState>,
    older: Mutex<Vec<SessionEventBody>>,
    permission_mode: Mutex<String>,
    access_mode: Mutex<String>,
    stderr: Arc<Mutex<String>>,
    pub(super) busy: AtomicBool,
    user_stopped: AtomicBool,
    pending: Mutex<PendingLines>,
    last_diff: Mutex<String>,
    /// 每个 message id 一份用量。实时流和回合结束都发绝对快照，不把同一调用再加一遍。
    usage_ledger: Mutex<super::usage::UsageLedger>,
    /// 串起「开始回合」和「回合结束」，避免结果状态盖住紧接着的新回合。
    status_lock: Mutex<()>,
    /// 已经写进 stdin 的用户消息数。和 `user_results` 一起判断旧 result 是不是还没追上。
    user_writes: AtomicU64,
    user_results: AtomicU64,
    /// `arm_turn` 的次数。新回合已经挂上时，旧 result 不再另开一个锚点。
    armed_user_turns: AtomicU64,
    /// 启动时转录里已有的 `absorbed_mid_turn` 条数。之后多出来的，是这次进程里被并进当前回合的写入。
    absorbed_base: AtomicU64,
    /// 还没写进 stdin 的本地排队。
    pub(super) queue_state: Mutex<super::queue::QueueState>,
    /// 启动时写进 `--add-dir` 的目录。Claude 没有在运行中追加目录的控制请求。
    add_dirs: Mutex<Vec<String>>,
    /// resume 时把转录里的历史写进通道。宿主已经存了时间线就不重放。
    replay_history: bool,
}

pub async fn open(
    project_path: String,
    access_mode: Option<String>,
    resume_native_id: Option<String>,
    side_of: Option<String>,
    writable_roots: Vec<String>,
    replay_history: bool,
    workbench_mcp: Option<crate::WorkbenchMcp>,
    events: EventSink,
) -> Result<Arc<Shared>, AgentError> {
    let project = PathBuf::from(project_path.trim());
    if project.as_os_str().is_empty() {
        return Err(AgentError::Runtime("没有项目目录".into()));
    }
    if let Some(parent) = side_of.as_deref().filter(|id| !history::is_uuid(id)) {
        return Err(AgentError::Runtime(format!("无效的会话 id：{parent}")));
    }
    // 侧边聊天分出来的是新会话，id 由这里定。
    let resume_native_id = if side_of.is_some() { None } else { resume_native_id };
    let (session_id, resume) = match resume_native_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(id) if history::is_uuid(id) => (id.to_string(), true),
        Some(id) => return Err(AgentError::Runtime(format!("无效的会话 id：{id}"))),
        None => (uuid::Uuid::new_v4().to_string(), false),
    };
    let permission_mode = command::permission_mode_for_access(access_mode.as_deref());
    let access = match access_mode.as_deref().unwrap_or("full") {
        "full" => "full",
        _ => "ask",
    };
    let bin = process::resolve_claude_bin()?;
    let add_dirs = command::normalize_add_dirs(&project.to_string_lossy(), &writable_roots);
    let args = command::cli_args(&Launch {
        session_id: session_id.clone(),
        resume,
        side_of,
        permission_mode: permission_mode.to_string(),
        model: None,
        effort: None,
        writable_roots: add_dirs.clone(),
        workbench_mcp,
    });
    let mut child = process::spawn(&bin, &args, &project)?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AgentError::Runtime("Claude Code 没有标准输入".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AgentError::Runtime("Claude Code 没有标准输出".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AgentError::Runtime("Claude Code 没有标准错误".into()))?;

    let shared = Arc::new(Shared {
        events,
        session_id,
        project_path: project,
        outbound: Mutex::new(None),
        child: Mutex::new(Some(child)),
        closed: AtomicBool::new(false),
        counter: AtomicU64::new(1),
        waiters: Mutex::new(HashMap::new()),
        intents: Mutex::new(HashMap::new()),
        prompts: Mutex::new(HashMap::new()),
        catalog: Mutex::new(catalog::empty_catalog()),
        goal: Mutex::new(None),
        map: Mutex::new(MapState::default()),
        older: Mutex::new(Vec::new()),
        permission_mode: Mutex::new(permission_mode.to_string()),
        access_mode: Mutex::new(access.to_string()),
        stderr: Arc::new(Mutex::new(String::new())),
        busy: AtomicBool::new(false),
        user_stopped: AtomicBool::new(false),
        pending: Mutex::new(PendingLines {
            ready: false,
            lines: Vec::new(),
        }),
        last_diff: Mutex::new(String::new()),
        usage_ledger: Mutex::new(super::usage::UsageLedger::default()),
        status_lock: Mutex::new(()),
        user_writes: AtomicU64::new(0),
        user_results: AtomicU64::new(0),
        armed_user_turns: AtomicU64::new(0),
        absorbed_base: AtomicU64::new(0),
        queue_state: Mutex::new(super::queue::QueueState::default()),
        add_dirs: Mutex::new(add_dirs),
        replay_history,
    });
    start_io(&shared, stdin, stdout, stderr);

    if let Err(err) = shared.startup().await {
        shared.shutdown();
        return Err(err);
    }
    Ok(shared)
}

/// 转录里被并进进行中回合的用户消息条数。
pub(super) fn count_absorbed(text: &str) -> u64 {
    text.lines()
        .filter(|line| line.contains("\"queue-operation\"") && line.contains("\"absorbed_mid_turn\""))
        .filter(|line| {
            serde_json::from_str::<Value>(line).is_ok_and(|entry| {
                entry.get("type").and_then(Value::as_str) == Some("queue-operation")
                    && entry.get("operation").and_then(Value::as_str) == Some("remove")
                    && entry.get("reason").and_then(Value::as_str) == Some("absorbed_mid_turn")
            })
        })
        .count() as u64
}

fn usage_delta(event: &SessionEventBody) -> bool {
    matches!(
        event,
        SessionEventBody::SessionUsage { scope, .. } if scope == "delta"
    )
}

impl Shared {
    async fn startup(&self) -> Result<(), AgentError> {
        let init = self
            .request(control::initialize_request(), Duration::from_secs(60))
            .await?;
        {
            let reported = init
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| self.map.lock().unwrap().model.clone());
            let mut catalog = self.catalog.lock().unwrap();
            catalog::apply_initialize(&mut catalog, &init, reported.as_deref());
        }
        // list_models / get_settings 失败不结束会话。通道断了才结束。
        match self
            .request(json!({"subtype": "list_models"}), Duration::from_secs(15))
            .await
        {
            Ok(payload) => {
                let mut catalog = self.catalog.lock().unwrap();
                catalog::apply_model_list(&mut catalog, &payload);
            }
            Err(AgentError::Closed) => {
                return Err(self.annotated("Claude Code 的控制通道已关闭".into()))
            }
            Err(err) if is_disconnect(&err) => return Err(err),
            Err(_) => {}
        }
        match self
            .request(json!({"subtype": "get_settings"}), Duration::from_secs(10))
            .await
        {
            Ok(payload) => {
                let mut catalog = self.catalog.lock().unwrap();
                catalog::apply_settings(&mut catalog, &payload);
            }
            Err(AgentError::Closed) => {
                return Err(self.annotated("Claude Code 的控制通道已关闭".into()))
            }
            Err(err) if is_disconnect(&err) => return Err(err),
            Err(_) => {}
        }
        self.install_history();
        let _ = self.events.send(SessionEventBody::StatusChanged {
            status: SessionStatus::Completed,
        });
        Ok(())
    }

    fn install_history(&self) {
        let model_before = self.map.lock().unwrap().model.clone();
        if let Some(path) = history::find_session_file(&self.session_id) {
            if let Some(text) = history::read_session_text(&path) {
                self.absorbed_base
                    .store(count_absorbed(&text), Ordering::SeqCst);
                let usage = {
                    let mut ledger = self.usage_ledger.lock().unwrap();
                    ledger.seed_transcript(&text);
                    ledger.snapshot()
                };
                let (events, diff) = {
                    let mut map = self.map.lock().unwrap();
                    map.subagent_dir = Some(history::subagent_dir(&path));
                    let events =
                        messages::events_from_transcript(&mut map, &text, Some(&self.project_path));
                    map.subagent_dir = None;
                    let diff = map.latest_diff();
                    map.model = model_before;
                    (events, diff)
                };
                if !diff.is_empty() {
                    *self.last_diff.lock().unwrap() = diff;
                }
                // 不重放时也要读一遍：记下已见过的消息、上一轮差异和目标，实时回声才不会重复。
                if !self.replay_history {
                    if let Some(goal) = events
                        .iter()
                        .rev()
                        .find(|event| matches!(event, SessionEventBody::Goal { .. }))
                    {
                        *self.goal.lock().unwrap() = Some(goal.clone());
                    }
                    self.mark_ready();
                    return;
                }
                let mut older = events;
                let start = older.len().saturating_sub(history::PAGE_SIZE);
                let page = older.split_off(start);
                *self.older.lock().unwrap() = older;
                for event in page {
                    if matches!(event, SessionEventBody::Goal { .. }) {
                        *self.goal.lock().unwrap() = Some(event.clone());
                    }
                    let _ = self.events.send(event);
                }
                if let Some(usage) = usage {
                    let _ = self.events.send(usage);
                }
            }
        }
        self.mark_ready();
    }

    /// 先消化积压，再打开实时通道。读取任务在 `ready` 之前继续把正文行放进队列，
    /// 所以历史 uuid 记上之前不会处理实时回声。
    fn mark_ready(&self) {
        loop {
            let lines = {
                let mut pending = self.pending.lock().unwrap();
                std::mem::take(&mut pending.lines)
            };
            if lines.is_empty() {
                let mut pending = self.pending.lock().unwrap();
                if pending.lines.is_empty() {
                    pending.ready = true;
                    return;
                }
                continue;
            }
            for line in &lines {
                self.dispatch(line);
            }
        }
    }

    pub fn load_older(&self) -> (Vec<SessionEventBody>, bool) {
        let mut older = self.older.lock().unwrap();
        if older.is_empty() {
            return (Vec::new(), true);
        }
        let start = older.len().saturating_sub(history::PAGE_SIZE);
        let page = older.split_off(start);
        let exhausted = older.is_empty();
        (page, exhausted)
    }

    pub fn last_turn_diff(&self) -> Result<String, AgentError> {
        let diff = self.last_diff.lock().unwrap().clone();
        if diff.trim().is_empty() {
            Err(AgentError::Runtime("还没有上一轮差异".into()))
        } else {
            Ok(diff)
        }
    }

    pub fn publish_goal(&self) {
        if let Some(event) = self.goal.lock().unwrap().clone() {
            let _ = self.events.send(event);
        }
    }

    pub fn send_text(&self, text: String) -> Result<(), AgentError> {
        self.submit(Value::String(text.clone()), text, Vec::new(), String::new())
            .map(|_| ())
    }

    pub(super) fn write_user_content(&self, content: &Value) -> Result<(), AgentError> {
        let line = serde_json::to_string(&control::user_message(&self.session_id, content.clone()))
            .map_err(|err| AgentError::Runtime(err.to_string()))?;
        self.write_line(&line)?;
        self.user_writes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    pub(super) fn begin_turn(&self) -> Result<(), AgentError> {
        let _guard = self.status_lock.lock().unwrap();
        if self.closed.load(Ordering::SeqCst) {
            return Err(AgentError::Closed);
        }
        if !self.prompts.lock().unwrap().is_empty() {
            return Err(AgentError::PendingPrompt);
        }
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err(AgentError::Busy);
        }
        self.arm_turn();
        let _ = self.events.send(SessionEventBody::StatusChanged {
            status: SessionStatus::Running,
        });
        Ok(())
    }

    pub(super) fn arm_turn(&self) {
        self.armed_user_turns.fetch_add(1, Ordering::SeqCst);
        self.user_stopped.store(false, Ordering::SeqCst);
        let turn_id = uuid::Uuid::new_v4().to_string();
        self.map.lock().unwrap().begin_turn(&turn_id);
        let mode =
            (self.permission_mode.lock().unwrap().as_str() == "plan").then(|| "plan".to_string());
        let _ = self
            .events
            .send(SessionEventBody::TurnAnchor { turn_id, mode });
    }

    pub(super) fn fail_turn(&self) {
        let _guard = self.status_lock.lock().unwrap();
        self.busy.store(false, Ordering::SeqCst);
        let _ = self.events.send(SessionEventBody::Error {
            message: "没能把消息写给 Claude Code".into(),
        });
        let _ = self.events.send(SessionEventBody::StatusChanged {
            status: SessionStatus::Failed,
        });
    }

    pub fn answer_prompt(&self, prompt_id: &str, answer: &PromptAnswer) -> Result<(), AgentError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(AgentError::Closed);
        }
        let kind = {
            let _guard = self.status_lock.lock().unwrap();
            self.prompts
                .lock()
                .unwrap()
                .get(prompt_id)
                .cloned()
                .ok_or_else(|| AgentError::UnknownPrompt(prompt_id.to_string()))?
        };
        let response = control::permission_result(&kind, answer)?;
        let line = serde_json::to_string(&control::control_success(prompt_id, response))
            .map_err(|err| AgentError::Runtime(err.to_string()))?;
        self.write_line(&line)?;
        let _guard = self.status_lock.lock().unwrap();
        let removed = self.prompts.lock().unwrap().remove(prompt_id).is_some();
        if !removed {
            return Ok(());
        }
        let _ = self.events.send(SessionEventBody::PromptResolved {
            prompt_id: prompt_id.to_string(),
            answer: answer_label(answer),
        });
        if matches!(kind, PermissionKind::ExitPlan { .. }) && answer_is_allow(answer) {
            let access = self.access_mode.lock().unwrap().clone();
            if let Ok(mode) = command::access_to_permission_mode(&access) {
                *self.permission_mode.lock().unwrap() = mode.to_string();
            }
            let _ = self.events.send(SessionEventBody::CollaborationMode {
                mode: "default".into(),
            });
        }
        if self.busy.load(Ordering::SeqCst) && self.prompts.lock().unwrap().is_empty() {
            let _ = self.events.send(SessionEventBody::StatusChanged {
                status: SessionStatus::Running,
            });
        }
        Ok(())
    }

    pub fn interrupt(&self) -> Result<(), AgentError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(AgentError::Closed);
        }
        let pending = {
            let _guard = self.status_lock.lock().unwrap();
            let pending: Vec<_> = self
                .prompts
                .lock()
                .unwrap()
                .drain()
                .map(|(id, _)| id)
                .collect();
            let active = self.busy.load(Ordering::SeqCst) || !pending.is_empty();
            if !active {
                return Ok(());
            }
            self.user_stopped.store(true, Ordering::SeqCst);
            // CLI 常把这次停止报成 aborted_streaming。标记留给 messages 消掉红条。
            self.map.lock().unwrap().request_user_stop();
            self.busy.store(false, Ordering::SeqCst);
            for id in &pending {
                let _ = self.events.send(SessionEventBody::PromptResolved {
                    prompt_id: id.clone(),
                    answer: "已中断".into(),
                });
            }
            let _ = self.events.send(SessionEventBody::StatusChanged {
                status: SessionStatus::Stopped,
            });
            pending
        };
        let _ = pending;
        self.enqueue(json!({"subtype": "interrupt"}), Some(Intent::Interrupt))?;
        Ok(())
    }

    pub fn current_access(&self) -> String {
        self.access_mode.lock().unwrap().clone()
    }

    pub fn set_sandbox(
        &self,
        mode: &str,
        network: bool,
        roots: &[String],
        profile: &str,
    ) -> Result<(), AgentError> {
        if network {
            return Err(AgentError::Runtime("不支持网络访问开关".into()));
        }
        let desired = command::normalize_add_dirs(&self.project_path.to_string_lossy(), roots);
        let launched = self.add_dirs.lock().unwrap().clone();
        if desired != launched {
            return Err(AgentError::Runtime(
                "Claude Code 的额外目录只在启动参数 --add-dir 里生效，这条会话已经启动".into(),
            ));
        }
        if !profile.trim().is_empty() {
            return Err(AgentError::Runtime("不支持具名权限配置档".into()));
        }
        let cli = command::access_to_permission_mode(mode)?;
        self.enqueue(
            json!({"subtype": "set_permission_mode", "mode": cli}),
            Some(Intent::SetPermission(cli.to_string())),
        )?;
        *self.access_mode.lock().unwrap() = if mode == "full" {
            "full".into()
        } else {
            "ask".into()
        };
        *self.permission_mode.lock().unwrap() = cli.to_string();
        Ok(())
    }

    pub fn set_tuning(
        &self,
        model: Option<String>,
        effort: Option<String>,
    ) -> Result<(), AgentError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(AgentError::Closed);
        }
        if let Some(model) = model
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
        {
            self.enqueue(
                json!({"subtype": "set_model", "model": model}),
                Some(Intent::SetModel(model)),
            )?;
        }
        if let Some(effort) = effort
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
        {
            self.enqueue(
                json!({
                    "subtype": "apply_flag_settings",
                    "settings": { "effortLevel": effort },
                }),
                Some(Intent::SetEffort(effort)),
            )?;
        }
        Ok(())
    }

    pub fn set_collaboration_mode(&self, mode: &str) -> Result<(), AgentError> {
        let cli = match mode {
            "plan" => "plan",
            "default" => {
                let access = self.access_mode.lock().unwrap().clone();
                command::access_to_permission_mode(&access).unwrap_or("default")
            }
            _ => return Err(AgentError::Runtime(format!("不认识的协作模式 {mode}"))),
        };
        self.enqueue(
            json!({"subtype": "set_permission_mode", "mode": cli}),
            Some(Intent::SetPermission(cli.to_string())),
        )?;
        *self.permission_mode.lock().unwrap() = cli.to_string();
        let _ = self.events.send(SessionEventBody::CollaborationMode {
            mode: mode.to_string(),
        });
        Ok(())
    }

    pub fn shutdown(&self) {
        let first = !self.closed.swap(true, Ordering::SeqCst);
        self.outbound.lock().unwrap().take();
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.start_kill();
        }
        if first {
            self.fail_waiters(self.stderr_message("Claude Code 已退出"));
        }
    }

    async fn request(&self, body: Value, timeout: Duration) -> Result<Value, AgentError> {
        let (tx, rx) = oneshot::channel();
        let id = self.next_id();
        self.waiters.lock().unwrap().insert(id.clone(), tx);
        let line = serde_json::to_string(&control::control_request(&id, body))
            .map_err(|err| AgentError::Runtime(err.to_string()))?;
        if let Err(err) = self.write_line(&line) {
            self.waiters.lock().unwrap().remove(&id);
            return Err(err);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(self.annotated(message)),
            Ok(Err(_)) => Err(self.annotated("Claude Code 的控制通道已关闭".into())),
            Err(_) => {
                self.waiters.lock().unwrap().remove(&id);
                Err(self.annotated("等待 Claude Code 响应超时".into()))
            }
        }
    }

    fn enqueue(&self, request: Value, intent: Option<Intent>) -> Result<(), AgentError> {
        let id = self.next_id();
        if let Some(intent) = intent {
            self.intents.lock().unwrap().insert(id.clone(), intent);
        }
        let line = serde_json::to_string(&control::control_request(&id, request))
            .map_err(|err| AgentError::Runtime(err.to_string()))?;
        if let Err(err) = self.write_line(&line) {
            self.intents.lock().unwrap().remove(&id);
            return Err(err);
        }
        Ok(())
    }

    fn next_id(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        control::request_id(n)
    }

    pub(super) fn write_line(&self, line: &str) -> Result<(), AgentError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(AgentError::Closed);
        }
        let guard = self.outbound.lock().unwrap();
        let tx = guard.as_ref().ok_or(AgentError::Closed)?;
        tx.send(line.to_string()).map_err(|_| AgentError::Closed)
    }

    fn handle_line(&self, line: &str) {
        if serde_json::from_str::<Value>(line).is_err() {
            return;
        }
        if bufferable(line) {
            let mut pending = self.pending.lock().unwrap();
            if !pending.ready {
                pending.lines.push(line.to_string());
                return;
            }
        }
        self.dispatch(line);
    }

    fn dispatch(&self, line: &str) {
        let (ingest, diff, model) = {
            let mut map = self.map.lock().unwrap();
            let ingest = messages::ingest_line(&mut map, line, true, Some(&self.project_path));
            let diff = map.latest_diff();
            let model = map.model.clone();
            (ingest, diff, model)
        };
        if !diff.is_empty() {
            *self.last_diff.lock().unwrap() = diff;
        }
        self.note_model(model);
        for event in ingest.events {
            self.emit_live(event);
        }
        if let Some(control) = ingest.control {
            self.on_control(control);
        }
    }

    fn note_model(&self, model: Option<String>) {
        let Some(model) = model.filter(|item| !item.is_empty()) else {
            return;
        };
        let mut catalog = self.catalog.lock().unwrap();
        if catalog.thread_model.is_none() {
            catalog::adopt_thread_model(&mut catalog, &model);
        }
    }

    fn emit_live(&self, event: SessionEventBody) {
        match event {
            SessionEventBody::StatusChanged { status } => self.emit_terminal(status),
            SessionEventBody::Goal { .. } => {
                *self.goal.lock().unwrap() = Some(event.clone());
                let _ = self.events.send(event);
            }
            other => {
                if usage_delta(&other) {
                    if let Some(snapshot) = self.usage_ledger.lock().unwrap().absorb_delta(&other) {
                        let _ = self.events.send(snapshot);
                    }
                } else {
                    let _ = self.events.send(other);
                }
            }
        }
    }

    /// 还要等几个 result。回合进行中写进去的消息，CLI 可能直接并进当前回合
    /// （2.1.312：转录记 `queue-operation` `remove`，`reason: absorbed_mid_turn`），这些不会再有自己的 result。
    /// 只有写入多于已到的 result 时才去读转录。
    fn expected_results(&self, seen: u64) -> u64 {
        let written = self.user_writes.load(Ordering::SeqCst);
        if written <= seen {
            return written;
        }
        let absorbed = history::find_session_file(&self.session_id)
            .and_then(|path| history::read_session_text(&path))
            .map(|text| count_absorbed(&text))
            .unwrap_or(0)
            .saturating_sub(self.absorbed_base.load(Ordering::SeqCst));
        written.saturating_sub(absorbed).max(seen)
    }

    fn refresh_usage_snapshot(&self) {
        let Some(path) = history::find_session_file(&self.session_id) else {
            return;
        };
        let Some(text) = history::read_session_text(&path) else {
            return;
        };
        let snapshot = {
            let mut ledger = self.usage_ledger.lock().unwrap();
            ledger.merge_transcript(&text);
            ledger.snapshot()
        };
        if let Some(snapshot) = snapshot {
            let _ = self.events.send(snapshot);
        }
    }

    fn emit_terminal(&self, mut status: SessionStatus) {
        let terminal = matches!(
            status,
            SessionStatus::Completed | SessionStatus::Failed | SessionStatus::Stopped
        );
        if !terminal {
            let _guard = self.status_lock.lock().unwrap();
            let _ = self.events.send(SessionEventBody::StatusChanged { status });
            return;
        }
        let seen = self.user_results.fetch_add(1, Ordering::SeqCst) + 1;
        let written = self.expected_results(seen);
        if seen < written {
            self.busy.store(true, Ordering::SeqCst);
            if self.armed_user_turns.load(Ordering::SeqCst) <= seen {
                self.arm_turn();
            }
            let _ = self.events.send(SessionEventBody::StatusChanged {
                status: SessionStatus::Running,
            });
            return;
        }
        let stopped_by_user = {
            let _guard = self.status_lock.lock().unwrap();
            let stopped_by_user = self.user_stopped.load(Ordering::SeqCst);
            if stopped_by_user {
                match status {
                    SessionStatus::Completed | SessionStatus::Failed => {
                        self.user_stopped.store(false, Ordering::SeqCst);
                    }
                    SessionStatus::Stopped => status = SessionStatus::Stopped,
                    _ => {}
                }
            }
            stopped_by_user
        };
        match self.finish_turn(status, stopped_by_user) {
            super::queue::ClosePlan::Start(item) => {
                self.busy.store(true, Ordering::SeqCst);
                self.start_queued_item(item);
            }
            super::queue::ClosePlan::Finish => {
                if self.busy.load(Ordering::SeqCst) && self.expected_results(seen) > seen {
                    return;
                }
                self.busy.store(false, Ordering::SeqCst);
                let _ = self.events.send(SessionEventBody::StatusChanged { status });
                self.refresh_usage_snapshot();
                self.fire_context_usage();
            }
        }
    }

    fn fire_context_usage(&self) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let _ = self.enqueue(
            json!({"subtype": "get_context_usage", "detail": "summary"}),
            Some(Intent::ContextUsage),
        );
    }

    fn on_control(&self, control: ControlIn) {
        match control {
            ControlIn::Response { request_id, result } => {
                let waiter = self.waiters.lock().unwrap().remove(&request_id);
                let intent = self.intents.lock().unwrap().remove(&request_id);
                if let Some(waiter) = waiter {
                    let _ = waiter.send(result.clone());
                }
                if let Some(intent) = intent {
                    self.apply_intent(intent, result);
                }
            }
            ControlIn::Request {
                request_id,
                request,
            } => self.on_request(&request_id, &request),
            ControlIn::Cancel { request_id } => self.on_cancel(&request_id),
        }
    }

    fn on_request(&self, request_id: &str, request: &Value) {
        let subtype = request.get("subtype").and_then(Value::as_str).unwrap_or("");
        if subtype == "active_goal" {
            let message = json!({
                "type": "active_goal",
                "value": request.get("value").cloned().unwrap_or(Value::Null),
            });
            if let Ok(line) = serde_json::to_string(&message) {
                self.dispatch(&line);
            }
            self.reply_success(request_id, json!({}));
            return;
        }
        if let Some((events, kind)) = messages::permission_events(request_id, request) {
            let _guard = self.status_lock.lock().unwrap();
            self.prompts
                .lock()
                .unwrap()
                .insert(request_id.to_string(), kind);
            for event in events {
                let _ = self.events.send(event);
            }
            let _ = self.events.send(SessionEventBody::StatusChanged {
                status: SessionStatus::NeedsInput,
            });
            return;
        }
        if subtype == "can_use_tool" {
            self.reply_error(request_id, "无法展示这次提问");
            return;
        }
        let message = if subtype.is_empty() {
            "不支持的控制请求".to_string()
        } else {
            format!("不支持的控制请求：{subtype}")
        };
        self.reply_error(request_id, &message);
    }

    fn on_cancel(&self, request_id: &str) {
        let _guard = self.status_lock.lock().unwrap();
        if self.prompts.lock().unwrap().remove(request_id).is_none() {
            return;
        }
        let _ = self.events.send(SessionEventBody::PromptResolved {
            prompt_id: request_id.to_string(),
            answer: "已中断".into(),
        });
        if self.prompts.lock().unwrap().is_empty() && self.busy.load(Ordering::SeqCst) {
            let _ = self.events.send(SessionEventBody::StatusChanged {
                status: SessionStatus::Running,
            });
        }
    }

    fn apply_intent(&self, intent: Intent, result: Result<Value, String>) {
        match (intent, result) {
            (Intent::ContextUsage | Intent::Interrupt, Err(_)) => {}
            (_, Err(message)) => {
                let _ = self.events.send(SessionEventBody::Error { message });
            }
            (Intent::SetModel(model), Ok(_)) => {
                let mut catalog = self.catalog.lock().unwrap();
                catalog::adopt_thread_model(&mut catalog, &model);
            }
            (Intent::SetEffort(effort), Ok(_)) => {
                self.catalog.lock().unwrap().thread_effort = Some(effort);
            }
            (Intent::SetPermission(mode), Ok(_)) => {
                *self.permission_mode.lock().unwrap() = mode;
            }
            (Intent::ContextUsage, Ok(payload)) => {
                let model = self
                    .catalog
                    .lock()
                    .unwrap()
                    .thread_model
                    .clone()
                    .or_else(|| self.map.lock().unwrap().model.clone());
                if let Some(event) = messages::context_usage_from_response(&payload, model) {
                    let _ = self.events.send(event);
                }
            }
            (Intent::Interrupt, Ok(_)) => {}
        }
    }

    fn reply_success(&self, request_id: &str, response: Value) {
        if let Ok(line) = serde_json::to_string(&control::control_success(request_id, response)) {
            let _ = self.write_line(&line);
        }
    }

    fn reply_error(&self, request_id: &str, message: &str) {
        if let Ok(line) = serde_json::to_string(&control::control_error(request_id, message)) {
            let _ = self.write_line(&line);
        }
    }

    fn on_eof(&self) {
        let first = !self.closed.swap(true, Ordering::SeqCst);
        self.busy.store(false, Ordering::SeqCst);
        self.outbound.lock().unwrap().take();
        let message = self.stderr_message("Claude Code 已退出");
        self.fail_waiters(message.clone());
        // 进程没了，还在跑的子 Agent 也跟着停了。
        for card in self.map.lock().unwrap().stop_subagents() {
            let _ = self.events.send(card);
        }
        if first && !self.user_stopped.load(Ordering::SeqCst) {
            let _ = self.events.send(SessionEventBody::Error { message });
            let _ = self.events.send(SessionEventBody::StatusChanged {
                status: SessionStatus::Failed,
            });
        }
    }

    fn fail_waiters(&self, message: String) {
        let mut waiters = self.waiters.lock().unwrap();
        for (_, waiter) in waiters.drain() {
            let _ = waiter.send(Err(message.clone()));
        }
    }

    fn stderr_message(&self, prefix: &str) -> String {
        let tail = self.stderr.lock().unwrap().trim().to_string();
        if tail.is_empty() {
            prefix.to_string()
        } else {
            format!("{prefix}\n{tail}")
        }
    }

    fn annotated(&self, message: String) -> AgentError {
        let tail = self.stderr.lock().unwrap().trim().to_string();
        if tail.is_empty() || message.contains(tail.as_str()) {
            AgentError::Runtime(message)
        } else {
            AgentError::Runtime(format!("{message}\n{tail}"))
        }
    }
}

fn start_io(
    shared: &Arc<Shared>,
    mut stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    *shared.outbound.lock().unwrap() = Some(tx);
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdin.write_all(b"\n").await.is_err() {
                break;
            }
            if stdin.flush().await.is_err() {
                break;
            }
        }
    });
    let stderr_buf = Arc::clone(&shared.stderr);
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => push_stderr(&stderr_buf, &decode_child_bytes(&buf)),
            }
        }
    });
    let reader_shared = Arc::clone(shared);
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    while matches!(buf.last(), Some(b'\n' | b'\r')) {
                        buf.pop();
                    }
                    let line = decode_child_bytes(&buf);
                    if line.trim().is_empty() {
                        continue;
                    }
                    reader_shared.handle_line(&line);
                }
            }
        }
        reader_shared.on_eof();
    });
}

fn push_stderr(buf: &Mutex<String>, chunk: &str) {
    let mut guard = buf.lock().unwrap();
    guard.push_str(chunk);
    if guard.len() > STDERR_CAP {
        let mut cut = guard.len() - STDERR_CAP;
        while cut < guard.len() && !guard.is_char_boundary(cut) {
            cut += 1;
        }
        guard.drain(..cut);
    }
}

fn bufferable(line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    !matches!(
        kind,
        "control_response" | "control_request" | "control_cancel_request" | "system"
    )
}

fn is_disconnect(err: &AgentError) -> bool {
    match err {
        AgentError::Closed => true,
        AgentError::Runtime(message) => message.contains("控制通道已关闭"),
        _ => false,
    }
}

fn answer_is_allow(answer: &PromptAnswer) -> bool {
    match answer {
        PromptAnswer::Single { value } => control::is_allow(value),
        _ => false,
    }
}

fn answer_label(answer: &PromptAnswer) -> String {
    match answer {
        PromptAnswer::Single { value } => {
            if control::is_allow(value) {
                "允许".into()
            } else if value == "reject" {
                "拒绝".into()
            } else {
                value.clone()
            }
        }
        PromptAnswer::Questions { skipped: true, .. } => "已跳过".into(),
        PromptAnswer::Questions { answers, .. } => {
            let parts: Vec<_> = answers
                .values()
                .filter(|item| !item.trim().is_empty())
                .cloned()
                .collect();
            if parts.is_empty() {
                "已回答".into()
            } else {
                parts.join("，")
            }
        }
        PromptAnswer::Elicitation { .. } => "已回答".into(),
    }
}

