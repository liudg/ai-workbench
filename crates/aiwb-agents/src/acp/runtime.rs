//! 一个 ACP 进程和上面的一条会话：收发、时间线、审批和设置。
//!
//! 进程由各适配器拉起，握手后用 [`Shared::open_thread`] 建或接上会话。
//! `session/load` 先把整段历史以 `session/update` 推完再回包；宿主已有时间线（`skip_history`）时丢掉这些推送。
//! 模型、强度、Fast 和计划模式在发下一条消息前用 `session/set_config_option` / `session/set_mode` 写进去。
//! 「完全访问」不靠启动参数重启进程：审批请求到了就替用户选「允许一次」，中途切换档位立刻生效。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::mpsc;

use super::config::{self, ModelConfig, FAST_CONFIG, FAST_TIER, MODEL_CONFIG};
use super::permission::{self, PermissionPending};
use super::rpc::{self, Incoming, Rpc, RpcError};
use super::updates::UpdateMap;
use super::{Dialect, PendingAnswer};
use aiwb_proc::decode_child_bytes;
use crate::{AgentError, EventSink, WorkbenchMcp};
use aiwb_core::models::{AgentCatalog, PromptAnswer, SessionEventBody, SessionStatus};

const STDERR_CAP: usize = 4000;
pub(crate) const HANDSHAKE: Duration = Duration::from_secs(60);
const SETTING: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Replay {
    Live,
    Emit,
    Drop,
}

/// 用户想要的模型参数。空字符串表示不覆盖，用 Agent 自己记住的。
#[derive(Default)]
pub(crate) struct Wanted {
    model: String,
    effort: String,
    fast: Option<bool>,
    pub(crate) plan: bool,
    roots: Vec<String>,
}

pub(crate) type PendingPrompt = (Value, Arc<dyn PendingAnswer>);

pub struct Shared {
    pub(crate) dialect: Arc<dyn Dialect>,
    pub(crate) events: EventSink,
    pub(crate) project: PathBuf,
    pub(crate) rpc: Rpc,
    child: Mutex<Option<Child>>,
    stderr: Arc<Mutex<String>>,
    pub(crate) closed: AtomicBool,
    session_id: Mutex<Option<String>>,
    pub catalog: Mutex<AgentCatalog>,
    pub(crate) map: Mutex<UpdateMap>,
    replay: Mutex<Replay>,
    pub(crate) prompts: Mutex<HashMap<String, PendingPrompt>>,
    pub(crate) queue: Mutex<super::queue::QueueState>,
    pub(crate) busy: AtomicBool,
    pub(crate) user_stopped: AtomicBool,
    pub(crate) status_lock: Mutex<()>,
    access: Mutex<String>,
    pub(crate) wanted: Mutex<Wanted>,
    /// 会话里 Agent 报回的当前参数，以及当前 `session/set_mode` 的档。
    config: Mutex<ModelConfig>,
    applied_mode: Mutex<String>,
    applied_roots: Mutex<Vec<String>>,
    /// 有工作台 MCP 时还没送出的说明。没有系统提示通道的 Agent 跟着这个进程的第一条提示走。
    pub(crate) instructions: Mutex<Option<String>>,
}

/// 新会话进程的素材。
pub struct Parts {
    pub dialect: Arc<dyn Dialect>,
    pub events: EventSink,
    pub project: PathBuf,
    pub access: String,
    pub catalog: AgentCatalog,
    pub instructions: Option<String>,
    pub roots: Vec<String>,
}

/// 这个进程要接上的会话。
pub enum Opening {
    New,
    /// 回放整段历史。`replay = false` 时丢掉回放。
    Load { id: String, replay: bool },
    /// 不回放，直接接上。
    Resume { id: String },
}

fn start_io(
    shared: &Arc<Shared>,
    mut stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
    mut rx: mpsc::UnboundedReceiver<String>,
) {
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
                || stdin.flush().await.is_err()
            {
                break;
            }
        }
    });
    let log = shared.stderr.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        while reader.read_until(b'\n', &mut buf).await.unwrap_or(0) > 0 {
            let text = decode_child_bytes(&buf).to_string();
            buf.clear();
            let mut log = log.lock().unwrap();
            log.push_str(&text);
            if log.len() > STDERR_CAP {
                let mut cut = log.len() - STDERR_CAP;
                while !log.is_char_boundary(cut) {
                    cut += 1;
                }
                log.drain(..cut);
            }
        }
    });
    let reader = shared.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(message) = rpc::parse(&line) {
                reader.dispatch(message);
            }
        }
        reader.closed.store(true, Ordering::SeqCst);
        reader.rpc.close();
    });
}

impl Shared {
    /// 不带进程。测试和 [`Self::spawned`] 用。
    pub fn detached(parts: Parts, outbound: mpsc::UnboundedSender<String>) -> Arc<Self> {
        let label = parts.dialect.label();
        let rules = parts.dialect.rules();
        let applied = parts.dialect.mode_id(false, &parts.access).to_string();
        let roots = parts.roots.clone();
        Arc::new(Self {
            dialect: parts.dialect,
            events: parts.events,
            map: Mutex::new(UpdateMap::new(&parts.project, rules)),
            project: parts.project,
            rpc: Rpc::new(label, outbound),
            child: Mutex::new(None),
            stderr: Arc::new(Mutex::new(String::new())),
            closed: AtomicBool::new(false),
            session_id: Mutex::new(None),
            catalog: Mutex::new(parts.catalog),
            replay: Mutex::new(Replay::Live),
            prompts: Mutex::new(HashMap::new()),
            queue: Mutex::new(super::queue::QueueState::default()),
            busy: AtomicBool::new(false),
            user_stopped: AtomicBool::new(false),
            status_lock: Mutex::new(()),
            access: Mutex::new(parts.access),
            wanted: Mutex::new(Wanted { roots: roots.clone(), ..Wanted::default() }),
            config: Mutex::new(ModelConfig::default()),
            applied_mode: Mutex::new(applied),
            applied_roots: Mutex::new(roots),
            instructions: Mutex::new(parts.instructions),
        })
    }

    /// 接上拉起的进程，开始收发。
    pub fn spawned(parts: Parts, mut child: Child) -> Result<Arc<Self>, AgentError> {
        let label = parts.dialect.label();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AgentError::Runtime(format!("{label} 没有标准输入")))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AgentError::Runtime(format!("{label} 没有标准输出")))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AgentError::Runtime(format!("{label} 没有标准错误")))?;
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        let shared = Self::detached(parts, tx);
        *shared.child.lock().unwrap() = Some(child);
        start_io(&shared, stdin, stdout, stderr, rx);
        Ok(shared)
    }

    #[cfg(test)]
    pub(crate) fn applied_mode(&self) -> String {
        self.applied_mode.lock().unwrap().clone()
    }

    #[cfg(test)]
    pub(crate) fn adopt_session_id(&self, id: &str) {
        *self.session_id.lock().unwrap() = Some(id.to_string());
    }

    pub(crate) async fn call(&self, method: &str, params: Value, timeout: Option<Duration>) -> Result<Value, AgentError> {
        let result = self.rpc.request(method, params, timeout).await;
        self.settle(method, result)
    }

    pub(crate) fn settle(&self, method: &str, result: Result<Result<Value, RpcError>, AgentError>) -> Result<Value, AgentError> {
        match result {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(err)) => Err(self.rpc_error(method, err)),
            Err(AgentError::Closed) => Err(self.exited()),
            Err(err) => Err(err),
        }
    }

    fn rpc_error(&self, method: &str, err: RpcError) -> AgentError {
        if err.code == rpc::AUTH_REQUIRED {
            return AgentError::Runtime(self.dialect.not_logged_in());
        }
        AgentError::Runtime(format!("{} {method} 失败：{}", self.dialect.label(), err.message))
    }

    fn exited(&self) -> AgentError {
        let tail = self.stderr.lock().unwrap().trim().to_string();
        let label = self.dialect.label();
        if tail.is_empty() {
            AgentError::Runtime(format!("{label} 已退出"))
        } else {
            AgentError::Runtime(format!("{label} 已退出：{tail}"))
        }
    }

    /// 建或接上一条会话。`params` 是 `cwd`、`mcpServers` 和这个 Agent 的扩展字段。
    pub(crate) async fn open_thread(&self, opening: Opening, mut params: Value) -> Result<(), AgentError> {
        let opened = match opening {
            Opening::New => self.call("session/new", params, Some(HANDSHAKE)).await?,
            Opening::Resume { id } => {
                params["sessionId"] = json!(id);
                let opened = self.call("session/resume", params, Some(HANDSHAKE)).await?;
                *self.session_id.lock().unwrap() = Some(id);
                opened
            }
            Opening::Load { id, replay } => {
                params["sessionId"] = json!(id);
                *self.replay.lock().unwrap() = if replay { Replay::Emit } else { Replay::Drop };
                let loaded = self.call("session/load", params, Some(HANDSHAKE)).await;
                let mode = std::mem::replace(&mut *self.replay.lock().unwrap(), Replay::Live);
                let tail = self.map.lock().unwrap().finish_replay();
                if mode == Replay::Emit {
                    for event in tail {
                        let _ = self.events.send(event);
                    }
                }
                let loaded = loaded?;
                *self.session_id.lock().unwrap() = Some(id);
                loaded
            }
        };
        if self.session_id().is_none() {
            let id = opened
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| AgentError::Runtime(format!("{} 没有返回会话 id", self.dialect.label())))?;
            *self.session_id.lock().unwrap() = Some(id.to_string());
        }
        self.adopt_session(&opened);
        Ok(())
    }

    /// 打开之后告诉上层可以发送了。
    pub(crate) fn opened(&self) {
        let _ = self.events.send(SessionEventBody::StatusChanged {
            status: SessionStatus::Completed,
        });
    }

    /// `session/new` / `session/load` 回包里的模式和模型参数。
    fn adopt_session(&self, payload: &Value) {
        if let Some(mode) = payload.pointer("/modes/currentModeId").and_then(Value::as_str) {
            *self.applied_mode.lock().unwrap() = mode.to_string();
            self.map.lock().unwrap().plan_mode = mode == "plan";
        }
        self.dialect.adopt_session(&mut self.catalog.lock().unwrap(), payload);
        if let Some(options) = config::config_options(payload) {
            self.adopt_config(&options);
        }
    }

    fn adopt_config(&self, options: &[Value]) {
        let config = config::read_config(options);
        {
            let mut catalog = self.catalog.lock().unwrap();
            catalog.thread_model = config.model.clone();
            catalog.thread_effort = config.effort.clone();
        }
        *self.config.lock().unwrap() = config;
    }

    pub fn session_id(&self) -> Option<String> {
        self.session_id.lock().unwrap().clone()
    }

    fn dispatch(&self, message: Incoming) {
        match message {
            Incoming::Response { id, result } => self.rpc.resolve(id, result),
            Incoming::Notification { method, params } => {
                if method == "session/update" {
                    self.on_update(&params);
                }
            }
            Incoming::Request { id, method, params } => self.on_request(id, &method, &params),
        }
    }

    pub(crate) fn on_update(&self, params: &Value) {
        let Some(update) = params.get("update") else {
            return;
        };
        let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");
        if kind == "available_commands_update" {
            self.catalog.lock().unwrap().commands = config::commands(update);
            return;
        }
        if kind == "config_option_update" {
            if let Some(options) = config::config_options(update) {
                self.adopt_config(&options);
            }
            return;
        }
        let replay = *self.replay.lock().unwrap();
        if replay == Replay::Drop {
            return;
        }
        // 实时回合里这是 Agent 回显用户刚发的话，用户气泡已经写过了。
        if replay == Replay::Live && kind == "user_message_chunk" {
            return;
        }
        let rewritten = self.dialect.rewrite_update(update);
        let update = rewritten.as_ref().unwrap_or(update);
        let session = params.get("sessionId").and_then(Value::as_str).unwrap_or("");
        if let Some(events) = self.dialect.on_update(session, update) {
            for event in events {
                let _ = self.events.send(event);
            }
            return;
        }
        let _guard = self.status_lock.lock().unwrap();
        if kind == "current_mode_update" {
            if let Some(mode) = update.get("currentModeId").and_then(Value::as_str) {
                *self.applied_mode.lock().unwrap() = mode.to_string();
            }
        }
        let events = self.map.lock().unwrap().apply(update);
        if let Some(plan) = events.iter().find_map(|event| match event {
            SessionEventBody::CollaborationMode { mode } => Some(mode == "plan"),
            _ => None,
        }) {
            if replay == Replay::Live {
                self.wanted.lock().unwrap().plan = plan;
            }
        }
        for event in events {
            let _ = self.events.send(event);
        }
        if matches!(kind, "agent_message_chunk" | "agent_thought_chunk" | "tool_call" | "tool_call_update") {
            let mut queue = self.queue.lock().unwrap();
            if queue.in_flight { queue.observed = true; }
            drop(queue);
            let _ = self.cancel_for_steering();
        }
    }

    pub(crate) fn on_request(&self, id: Value, method: &str, params: &Value) {
        if self.dialect.asks_user(method) {
            let _guard = self.status_lock.lock().unwrap();
            let mut queue = self.queue.lock().unwrap();
            if queue.in_flight { queue.observed = true; }
            drop(queue);
            let _ = self.cancel_for_steering();
            if self.user_stopped.load(Ordering::SeqCst) || self.queue.lock().unwrap().cancelling {
                let _ = self.rpc.respond(&id, self.dialect.cancelled_reply(method));
                return;
            }
            if method == "session/request_permission" {
                // 工作台的工具只作用于这个会话自己的子任务，免审批（同 Claude 的 `--allowedTools mcp__aiwb`）。
                if self.access.lock().unwrap().as_str() == "full" || self.dialect.workbench_tool(params) {
                    if let Some(option) = permission::allow_once(params) {
                        let _ = self.rpc.respond(
                            &id,
                            json!({ "outcome": { "outcome": "selected", "optionId": option } }),
                        );
                        return;
                    }
                }
            }
        }
        if method == "session/request_permission" {
            let prompt_id = permission::prompt_id(&id);
            let (event, options) = permission::permission_prompt(&prompt_id, params);
            self.raise(id, prompt_id, Arc::new(PermissionPending { options }), vec![event]);
            return;
        }
        if !self.dialect.on_request(self, &id, method, params) {
            let _ = self
                .rpc
                .respond_error(&id, rpc::METHOD_NOT_FOUND, &format!("不支持 {method}"));
        }
    }

    /// 把一个要用户回答的问题写进时间线。
    pub(crate) fn raise(&self, rpc_id: Value, prompt_id: String, pending: Arc<dyn PendingAnswer>, events: Vec<SessionEventBody>) {
        let _guard = self.status_lock.lock().unwrap();
        if self.user_stopped.load(Ordering::SeqCst) || self.queue.lock().unwrap().cancelling {
            let _ = self.rpc.respond(&rpc_id, pending.cancelled());
            return;
        }
        self.prompts
            .lock()
            .unwrap()
            .insert(prompt_id, (rpc_id, pending));
        for event in events {
            let _ = self.events.send(event);
        }
        let _ = self.events.send(SessionEventBody::StatusChanged {
            status: SessionStatus::NeedsInput,
        });
    }

    /// 从转录读出来的一步，走同一份时间线映射。每一步的回答单独成段。
    pub(crate) fn apply_step(&self, update: &Value) {
        let _guard = self.status_lock.lock().unwrap();
        let mut map = self.map.lock().unwrap();
        if update.get("sessionUpdate").and_then(Value::as_str) == Some("agent_message_chunk") {
            map.continue_turn();
        }
        let events = map.apply(update);
        drop(map);
        for event in events {
            let _ = self.events.send(event);
        }
    }

    pub(crate) fn finish_command(&self, command: &str, output: &str) {
        let _guard = self.status_lock.lock().unwrap();
        let event = self.map.lock().unwrap().finish_command(command, output);
        if let Some(event) = event {
            let _ = self.events.send(event);
        }
    }

    /// 宿主自己问用户的卡片，没有 Agent 在等回包，也不改会话状态。
    pub(crate) fn raise_local(&self, prompt_id: String, pending: Arc<dyn PendingAnswer>, event: SessionEventBody) {
        self.prompts.lock().unwrap().insert(prompt_id, (Value::Null, pending));
        let _ = self.events.send(event);
    }

    /// 没有在跑的回合，也没有排队的消息和待答的问题。
    pub(crate) fn is_idle(&self) -> bool {
        !self.busy.load(Ordering::SeqCst)
            && self.prompts.lock().unwrap().is_empty()
            && self.queue.lock().unwrap().is_empty()
    }

    pub fn answer_prompt(self: &Arc<Self>, prompt_id: &str, answer: &PromptAnswer) -> Result<(), AgentError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(AgentError::Closed);
        }
        let (rpc_id, pending) = self
            .prompts
            .lock()
            .unwrap()
            .get(prompt_id)
            .cloned()
            .ok_or_else(|| AgentError::UnknownPrompt(prompt_id.to_string()))?;
        let (result, label) = pending.respond(answer)?;
        // 宿主自己问的（比如要不要实施计划）没有 Agent 在等回包。
        if !rpc_id.is_null() {
            self.rpc.respond(&rpc_id, result.clone())?;
        }
        let _guard = self.status_lock.lock().unwrap();
        if self.prompts.lock().unwrap().remove(prompt_id).is_none() {
            return Ok(());
        }
        let _ = self.events.send(SessionEventBody::PromptResolved {
            prompt_id: prompt_id.to_string(),
            answer: label,
        });
        pending.settled(self, &result);
        if self.busy.load(Ordering::SeqCst) && self.prompts.lock().unwrap().is_empty() {
            let _ = self.events.send(SessionEventBody::StatusChanged {
                status: SessionStatus::Running,
            });
        }
        Ok(())
    }

    /// 发消息前把额外目录、模式、模型、强度和 Fast 对齐到用户的选择。只发有变化的项。
    pub(crate) async fn apply_settings(&self, session_id: &str) -> Result<(), AgentError> {
        let (plan, model, effort, fast, roots) = {
            let wanted = self.wanted.lock().unwrap();
            (wanted.plan, wanted.model.clone(), wanted.effort.clone(), wanted.fast, wanted.roots.clone())
        };
        if roots != *self.applied_roots.lock().unwrap() {
            if let Some(params) = self.dialect.reopen_params(self, &roots) {
                self.call("session/close", json!({ "sessionId": session_id }), Some(SETTING)).await?;
                self.open_thread(Opening::Resume { id: session_id.to_string() }, params).await?;
                *self.applied_roots.lock().unwrap() = roots;
            }
        }
        let access = self.current_access();
        let mode = self.dialect.mode_id(plan, &access);
        if mode != self.applied_mode.lock().unwrap().as_str() {
            self.call(
                "session/set_mode",
                json!({ "sessionId": session_id, "modeId": mode }),
                Some(SETTING),
            )
            .await?;
            *self.applied_mode.lock().unwrap() = mode.to_string();
        }
        let current = self.config.lock().unwrap().clone();
        if !model.is_empty() && current.model.as_deref() != Some(model.as_str()) {
            self.set_config(session_id, MODEL_CONFIG, &model).await?;
        }
        let current = self.config.lock().unwrap().clone();
        if let Some(effort_id) = current.effort_id.as_deref() {
            if !effort.is_empty()
                && current.effort.as_deref() != Some(effort.as_str())
                && current.effort_values.iter().any(|value| value == &effort)
            {
                self.set_config(session_id, effort_id, &effort).await?;
            }
        }
        let current = self.config.lock().unwrap().clone();
        if let (Some(want), Some(have)) = (fast, current.fast) {
            if want != have {
                self.set_config(session_id, FAST_CONFIG, if want { "true" } else { "false" })
                    .await?;
            }
        }
        Ok(())
    }

    async fn set_config(&self, session_id: &str, config_id: &str, value: &str) -> Result<(), AgentError> {
        let reply = self
            .call(
                "session/set_config_option",
                json!({ "sessionId": session_id, "configId": config_id, "value": value }),
                Some(SETTING),
            )
            .await?;
        if let Some(options) = config::config_options(&reply) {
            self.adopt_config(&options);
        }
        Ok(())
    }

    pub(crate) fn finish_status(&self, result: Result<Result<Value, RpcError>, AgentError>) -> SessionStatus {
        let stopped = self.user_stopped.load(Ordering::SeqCst);
        let left: Vec<String> = self.prompts.lock().unwrap().drain().map(|(id, _)| id).collect();
        for id in left {
            let _ = self.events.send(SessionEventBody::PromptResolved {
                prompt_id: id,
                answer: "已结束".into(),
            });
        }
        // 回合以报错文字收尾：Agent 当成回答发出来的后端报错，算失败。
        let backend_error = self.map.lock().unwrap().take_error();
        if let Ok(Ok(reply)) = &result {
            for event in self.dialect.turn_reply(self, reply) {
                let _ = self.events.send(event);
            }
        }
        let status = match result {
            Ok(Ok(reply)) => match reply.get("stopReason").and_then(Value::as_str).unwrap_or("") {
                "cancelled" => SessionStatus::Stopped,
                "max_tokens" => {
                    let _ = self.events.send(SessionEventBody::System {
                        text: "回复达到长度上限，已停止。".into(),
                    });
                    SessionStatus::Completed
                }
                "max_turn_requests" => {
                    let _ = self.events.send(SessionEventBody::System {
                        text: "这一轮的请求次数到了上限，已停止。".into(),
                    });
                    SessionStatus::Completed
                }
                "refusal" => {
                    let _ = self.events.send(SessionEventBody::Error {
                        message: "模型拒绝了这次请求。".into(),
                    });
                    SessionStatus::Failed
                }
                _ if stopped => SessionStatus::Stopped,
                _ if backend_error.is_some() => {
                    let _ = self.events.send(SessionEventBody::Error {
                        message: self.dialect.rules().error_message(backend_error.as_deref().unwrap_or("")),
                    });
                    SessionStatus::Failed
                }
                _ => SessionStatus::Completed,
            },
            Ok(Err(_)) if stopped => SessionStatus::Stopped,
            Ok(Err(err)) => {
                let _ = self.events.send(SessionEventBody::Error {
                    message: self.rpc_error("session/prompt", err).to_string(),
                });
                SessionStatus::Failed
            }
            Err(_) => {
                let _ = self.events.send(SessionEventBody::Error {
                    message: self.exited().to_string(),
                });
                SessionStatus::Failed
            }
        };
        if status != SessionStatus::Completed {
            for event in self.map.lock().unwrap().stop_tools() {
                let _ = self.events.send(event);
            }
            for event in self.dialect.stop_extras() {
                let _ = self.events.send(event);
            }
        }
        status
    }

    pub fn last_turn_diff(&self) -> Result<String, AgentError> {
        let diff = self.map.lock().unwrap().last_diff.clone();
        if diff.trim().is_empty() {
            Err(AgentError::Runtime("还没有上一轮差异".into()))
        } else {
            Ok(diff)
        }
    }

    pub fn set_access(&self, mode: &str) {
        *self.access.lock().unwrap() = self.dialect.access_level(mode).to_string();
    }

    pub fn current_access(&self) -> String {
        self.access.lock().unwrap().clone()
    }

    pub fn set_roots(&self, roots: &[String]) {
        self.wanted.lock().unwrap().roots = roots.to_vec();
    }

    /// 能不能中途换额外目录。
    pub fn can_reopen(&self) -> bool {
        self.dialect.reopen_params(self, &[]).is_some()
    }

    pub fn set_tuning(&self, model: Option<String>, effort: Option<String>) {
        let mut wanted = self.wanted.lock().unwrap();
        if let Some(model) = model {
            wanted.model = model.trim().to_string();
        }
        if let Some(effort) = effort {
            wanted.effort = effort.trim().to_string();
        }
    }

    pub fn set_fast(&self, tier: Option<String>) {
        self.wanted.lock().unwrap().fast = Some(tier.as_deref() == Some(FAST_TIER));
    }

    pub fn set_plan(&self, plan: bool) {
        self.wanted.lock().unwrap().plan = plan;
        let _ = self.events.send(SessionEventBody::CollaborationMode {
            mode: if plan { "plan" } else { "default" }.into(),
        });
    }

    pub fn shutdown(&self) {
        for event in self.dialect.stop_extras() {
            let _ = self.events.send(event);
        }
        self.closed.store(true, Ordering::SeqCst);
        self.rpc.close();
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.start_kill();
        }
    }

    /// 关掉并等进程退出。进程还在时 Windows 上 `store.db` 被占着，紧接着删会话会失败。
    pub async fn shutdown_and_wait(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.rpc.close();
        let child = self.child.lock().unwrap().take();
        if let Some(mut child) = child {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
        }
        if let Some(id) = self.session_id() {
            self.dialect.after_exit(&id);
        }
    }
}

/// 工作台 MCP 按 ACP 的 `McpServerHttp` 写进 `session/new` / `session/load`，按会话加载，
/// 不动用户自己配的 MCP。
pub(crate) fn mcp_servers(mcp: Option<&WorkbenchMcp>) -> Value {
    match mcp {
        Some(mcp) => json!([{
            "name": WorkbenchMcp::SERVER_NAME,
            "type": "http",
            "url": mcp.url,
            "headers": [{ "name": "Authorization", "value": mcp.authorization() }],
        }]),
        None => json!([]),
    }
}
