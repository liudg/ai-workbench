//! `agent acp` 进程和一条 ACP 会话。
//!
//! 启动顺序：`initialize` → `cursor/list_available_models` → `session/new` 或 `session/load`。
//! 冷启动要联网取模型目录，本进程里排队握手。取不到时怎么重试见 [`super::retry`]。
//! 只探模型目录（不 `persist`、不 resume）时不建会话，免得在 `~/.cursor/acp-sessions` 留下空会话。
//! `session/load` 先把整段历史以 `session/update` 推完再回包；宿主已有时间线（`skip_history`）时丢掉这些推送。
//!
//! 模型、强度、Fast 和计划模式在发下一条消息前用 `session/set_config_option` / `session/set_mode` 写进去。
//! 「完全访问」不靠 `--force` 重启进程：审批请求到了就替用户选「允许一次」，中途切换档位立刻生效。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::mpsc;

use super::catalog::{self, ModelConfig, FAST_CONFIG, FAST_TIER, MODEL_CONFIG};
use super::directory;
use super::process::{self, Launcher};
use super::prompts::{self, Pending};
use super::retry::{self, Miss};
use super::rpc::{self, Incoming, Rpc, RpcError};
use super::subagents::Subagents;
use super::updates::UpdateMap;
use aiwb_proc::decode_child_bytes;
use crate::{AgentError, EventSink, TurnDelivery, WorkbenchMcp};
use aiwb_core::models::{AgentCatalog, PromptAnswer, SessionEventBody, SessionStatus};

const STDERR_CAP: usize = 4000;
const HANDSHAKE: Duration = Duration::from_secs(60);
const SETTING: Duration = Duration::from_secs(30);

/// 同一时刻只让一个 `agent acp` 走初始化。
fn startup_gate() -> &'static tokio::sync::Mutex<()> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub fn services_unavailable(err: &RpcError) -> bool {
    err.code == rpc::INTERNAL_ERROR && err.message.contains("Failed to initialize ACP services")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Replay {
    Live,
    Emit,
    Drop,
}

/// 用户想要的模型参数。空字符串表示不覆盖，用 Cursor 自己记住的。
#[derive(Default)]
struct Wanted {
    model: String,
    effort: String,
    fast: Option<bool>,
    plan: bool,
}

pub struct Shared {
    events: EventSink,
    project: PathBuf,
    rpc: Rpc,
    child: Mutex<Option<Child>>,
    stderr: Arc<Mutex<String>>,
    closed: AtomicBool,
    session_id: Mutex<Option<String>>,
    pub catalog: Mutex<AgentCatalog>,
    map: Mutex<UpdateMap>,
    subagents: Mutex<Subagents>,
    replay: Mutex<Replay>,
    prompts: Mutex<HashMap<String, (Value, Pending)>>,
    busy: AtomicBool,
    user_stopped: AtomicBool,
    status_lock: Mutex<()>,
    access: Mutex<String>,
    wanted: Mutex<Wanted>,
    /// 会话里 Cursor 报回的当前参数，以及当前模式是不是 plan。
    config: Mutex<ModelConfig>,
    applied_plan: AtomicBool,
    /// 有工作台 MCP 时还没送出的说明。ACP 没有系统提示字段，跟着这个进程的第一条提示走。
    instructions: Mutex<Option<&'static str>>,
}

pub struct Open {
    pub project_path: String,
    pub access_mode: Option<String>,
    pub resume: Option<String>,
    pub persist: bool,
    pub replay_history: bool,
    pub workbench_mcp: Option<WorkbenchMcp>,
}

pub async fn open(options: Open, events: EventSink) -> Result<Arc<Shared>, AgentError> {
    let project = PathBuf::from(options.project_path.trim());
    if project.as_os_str().is_empty() {
        return Err(AgentError::Runtime("没有项目目录".into()));
    }
    let resume = options
        .resume
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    if let Some(id) = resume.as_deref() {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err(AgentError::Runtime(format!("无效的会话 id：{id}")));
        }
    }
    let launcher = process::resolve()?;
    let shared = retry::with_restarts(|| launch(&launcher, &project, &options, &events)).await?;
    let mcp_servers = mcp_servers(options.workbench_mcp.as_ref());
    let opened = shared
        .startup(resume, options.persist, options.replay_history, mcp_servers)
        .await;
    if let Err(err) = opened {
        shared.shutdown();
        return Err(err);
    }
    Ok(shared)
}

/// 起一个 `agent acp`，握手并取到模型目录。没取到就关掉这个进程。
async fn launch(
    launcher: &Launcher,
    project: &Path,
    options: &Open,
    events: &EventSink,
) -> Result<Arc<Shared>, Miss> {
    let mut child = process::spawn(launcher, project)?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AgentError::Runtime("Cursor Agent 没有标准输入".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AgentError::Runtime("Cursor Agent 没有标准输出".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AgentError::Runtime("Cursor Agent 没有标准错误".into()))?;
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    let access = match options.access_mode.as_deref().unwrap_or("full") {
        "full" => "full",
        _ => "ask",
    };
    let shared = Arc::new(Shared {
        events: events.clone(),
        map: Mutex::new(UpdateMap::new(project)),
        subagents: Mutex::new(Subagents::new(project)),
        project: project.to_path_buf(),
        rpc: Rpc::new(tx),
        child: Mutex::new(Some(child)),
        stderr: Arc::new(Mutex::new(String::new())),
        closed: AtomicBool::new(false),
        session_id: Mutex::new(None),
        catalog: Mutex::new(catalog::empty_catalog()),
        replay: Mutex::new(Replay::Live),
        prompts: Mutex::new(HashMap::new()),
        busy: AtomicBool::new(false),
        user_stopped: AtomicBool::new(false),
        status_lock: Mutex::new(()),
        access: Mutex::new(access.to_string()),
        wanted: Mutex::new(Wanted::default()),
        config: Mutex::new(ModelConfig::default()),
        applied_plan: AtomicBool::new(false),
        instructions: Mutex::new(options.workbench_mcp.as_ref().map(|_| WorkbenchMcp::INSTRUCTIONS)),
    });
    start_io(&shared, stdin, stdout, stderr, rx);
    let models = {
        let _gate = startup_gate().lock().await;
        shared.handshake().await
    };
    match models {
        Ok(models) => {
            catalog::apply_model_list(&mut shared.catalog.lock().unwrap(), &models);
            Ok(shared)
        }
        Err(miss) => {
            shared.shutdown_and_wait().await;
            Err(miss)
        }
    }
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
    async fn call(&self, method: &str, params: Value, timeout: Option<Duration>) -> Result<Value, AgentError> {
        let result = self.rpc.request(method, params, timeout).await;
        self.settle(method, result)
    }

    fn settle(&self, method: &str, result: Result<Result<Value, RpcError>, AgentError>) -> Result<Value, AgentError> {
        match result {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(err)) => Err(self.rpc_error(method, err)),
            Err(AgentError::Closed) => Err(self.exited()),
            Err(err) => Err(err),
        }
    }

    fn rpc_error(&self, method: &str, err: RpcError) -> AgentError {
        if err.code == rpc::AUTH_REQUIRED {
            return AgentError::Runtime("Cursor Agent 还没有登录。请在终端运行 `agent login` 后再试。".into());
        }
        AgentError::Runtime(format!("Cursor Agent {method} 失败：{}", err.message))
    }

    fn exited(&self) -> AgentError {
        let tail = self.stderr.lock().unwrap().trim().to_string();
        if tail.is_empty() {
            AgentError::Runtime("Cursor Agent 已退出".into())
        } else {
            AgentError::Runtime(format!("Cursor Agent 已退出：{tail}"))
        }
    }

    async fn handshake(&self) -> Result<Value, Miss> {
        self.call(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                    "_meta": { "parameterizedModelPicker": true, "subagents": true },
                },
                "clientInfo": { "name": "ai-workbench", "version": env!("CARGO_PKG_VERSION") },
            }),
            Some(HANDSHAKE),
        )
        .await?;
        retry::refetch(|| self.fetch_models()).await
    }

    async fn fetch_models(&self) -> Result<Value, Miss> {
        const METHOD: &str = "cursor/list_available_models";
        let reply = tokio::time::timeout(HANDSHAKE, self.rpc.request(METHOD, json!({}), None));
        let Ok(result) = reply.await else {
            return Err(Miss::Stalled);
        };
        if let Ok(Err(err)) = &result {
            if services_unavailable(err) {
                return Err(Miss::Services(err.message.clone()));
            }
        }
        let models = self.settle(METHOD, result)?;
        if catalog::has_models(&models) {
            Ok(models)
        } else {
            Err(Miss::Empty)
        }
    }

    async fn startup(
        &self,
        resume: Option<String>,
        persist: bool,
        replay_history: bool,
        mcp_servers: Value,
    ) -> Result<(), AgentError> {
        let cwd = self.project.to_string_lossy().to_string();
        // 没发过消息的会话只有 meta.json，`session/load` 认不出来。里面没有历史，换一个新会话。
        let placeholder = resume.as_deref().filter(|id| directory::is_placeholder(id)).map(str::to_string);
        let resume = if placeholder.is_some() { None } else { resume };
        let persist = persist || placeholder.is_some();
        if let Some(id) = resume {
            *self.replay.lock().unwrap() = if replay_history { Replay::Emit } else { Replay::Drop };
            let loaded = self
                .call(
                    "session/load",
                    json!({ "sessionId": id, "cwd": cwd, "mcpServers": mcp_servers }),
                    Some(HANDSHAKE),
                )
                .await;
            let replay = std::mem::replace(&mut *self.replay.lock().unwrap(), Replay::Live);
            let tail = self.map.lock().unwrap().finish_replay();
            if replay == Replay::Emit {
                for event in tail {
                    let _ = self.events.send(event);
                }
            }
            let loaded = loaded?;
            *self.session_id.lock().unwrap() = Some(id);
            self.adopt_session(&loaded);
        } else if persist {
            let created = self
                .call("session/new", json!({ "cwd": cwd, "mcpServers": mcp_servers }), Some(HANDSHAKE))
                .await?;
            let id = created
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| AgentError::Runtime("Cursor Agent 没有返回会话 id".into()))?;
            *self.session_id.lock().unwrap() = Some(id.to_string());
            self.adopt_session(&created);
            if let Some(old) = placeholder {
                let _ = directory::remove(&old);
            }
        }
        let _ = self.events.send(SessionEventBody::StatusChanged {
            status: SessionStatus::Completed,
        });
        Ok(())
    }

    /// `session/new` / `session/load` 回包里的模式和模型参数。
    fn adopt_session(&self, payload: &Value) {
        let plan = payload
            .pointer("/modes/currentModeId")
            .and_then(Value::as_str)
            == Some("plan");
        self.applied_plan.store(plan, Ordering::SeqCst);
        self.map.lock().unwrap().plan_mode = plan;
        if let Some(options) = catalog::config_options(payload) {
            self.adopt_config(&options);
        }
    }

    fn adopt_config(&self, options: &[Value]) {
        let config = catalog::read_config(options);
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

    fn on_update(&self, params: &Value) {
        let Some(update) = params.get("update") else {
            return;
        };
        if update.get("sessionUpdate").and_then(Value::as_str) == Some("available_commands_update") {
            self.catalog.lock().unwrap().commands = catalog::commands(update);
            return;
        }
        let replay = *self.replay.lock().unwrap();
        if replay == Replay::Drop {
            return;
        }
        let session = params.get("sessionId").and_then(Value::as_str).unwrap_or("");
        if let Some(events) = self.subagents.lock().unwrap().apply(session, update) {
            for event in events {
                let _ = self.events.send(event);
            }
            return;
        }
        let events = self.map.lock().unwrap().apply(update);
        if let Some(mode) = events.iter().find_map(|event| match event {
            SessionEventBody::CollaborationMode { mode } => Some(mode == "plan"),
            _ => None,
        }) {
            self.applied_plan.store(mode, Ordering::SeqCst);
            if replay == Replay::Live {
                self.wanted.lock().unwrap().plan = mode;
            }
        }
        for event in events {
            let _ = self.events.send(event);
        }
    }

    fn on_request(&self, id: Value, method: &str, params: &Value) {
        match method {
            "session/request_permission" => {
                // 工作台的工具只作用于这个会话自己的子任务，免审批（同 Claude 的 `--allowedTools mcp__aiwb`）。
                if self.access.lock().unwrap().as_str() == "full" || prompts::workbench_tool(params) {
                    if let Some(option) = prompts::allow_once(params) {
                        let _ = self.rpc.respond(
                            &id,
                            json!({ "outcome": { "outcome": "selected", "optionId": option } }),
                        );
                        return;
                    }
                }
                let prompt_id = prompts::prompt_id(&id);
                let (event, pending) = prompts::permission_prompt(&prompt_id, params);
                self.raise(id, prompt_id, pending, vec![event]);
            }
            "cursor/ask_question" => {
                let prompt_id = prompts::prompt_id(&id);
                let (event, pending) = prompts::question_prompt(&prompt_id, params);
                self.raise(id, prompt_id, pending, vec![event]);
            }
            "cursor/create_plan" => {
                let prompt_id = prompts::prompt_id(&id);
                let mut events = Vec::new();
                let text = prompts::plan_text(params);
                let tool = params.get("toolCallId").and_then(Value::as_str).unwrap_or("");
                if !text.is_empty() {
                    events.push(SessionEventBody::PlanText {
                        text,
                        stream_id: Some(format!("plan-{tool}")),
                        mode: Some("plan".into()),
                    });
                }
                if let Some(todos) = params.get("todos").filter(|todos| {
                    todos.as_array().is_some_and(|items| !items.is_empty())
                }) {
                    let mut map = self.map.lock().unwrap();
                    map.set_todos(todos);
                    events.push(map.todo_steps());
                }
                let (event, pending) = prompts::plan_prompt(&prompt_id);
                events.push(event);
                self.raise(id, prompt_id, pending, events);
            }
            "cursor/update_todos" => {
                let _ = self.rpc.respond(&id, json!({}));
                let events = self.map.lock().unwrap().apply_todos(params);
                for event in events {
                    let _ = self.events.send(event);
                }
            }
            "cursor/generate_image" => {
                let _ = self.rpc.respond(&id, json!({}));
                let events = self.map.lock().unwrap().attach_image(params);
                for event in events {
                    let _ = self.events.send(event);
                }
            }
            // 子 Agent 跑完：补上用时和模型。
            "cursor/task" => {
                let _ = self.rpc.respond(&id, json!({}));
                for event in self.subagents.lock().unwrap().task_done(params) {
                    let _ = self.events.send(event);
                }
            }
            _ => {
                let _ = self
                    .rpc
                    .respond_error(&id, rpc::METHOD_NOT_FOUND, &format!("不支持 {method}"));
            }
        }
    }

    fn raise(&self, rpc_id: Value, prompt_id: String, pending: Pending, events: Vec<SessionEventBody>) {
        let _guard = self.status_lock.lock().unwrap();
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

    pub fn answer_prompt(&self, prompt_id: &str, answer: &PromptAnswer) -> Result<(), AgentError> {
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
        let (result, label) = prompts::response(&pending, answer)?;
        self.rpc.respond(&rpc_id, result.clone())?;
        let _guard = self.status_lock.lock().unwrap();
        if self.prompts.lock().unwrap().remove(prompt_id).is_none() {
            return Ok(());
        }
        let _ = self.events.send(SessionEventBody::PromptResolved {
            prompt_id: prompt_id.to_string(),
            answer: label,
        });
        if matches!(pending, Pending::Plan) && prompts::plan_accepted(&result) {
            // 采纳计划后回到 Agent 模式，下一条消息就能动手改。
            self.wanted.lock().unwrap().plan = false;
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

    /// 开一轮。图片已经折成 ACP 的 `image` 块。
    pub fn submit(self: &Arc<Self>, mut blocks: Vec<Value>) -> Result<TurnDelivery, AgentError> {
        let session_id = self
            .session_id()
            .ok_or_else(|| AgentError::Runtime("Cursor Agent 会话还没有建立".into()))?;
        // 斜杠命令得在提示开头，说明留到下一条普通消息（照 t3code `t3AcpPromptWithInstructions`）。
        let command = blocks
            .first()
            .and_then(|block| block.get("text"))
            .and_then(Value::as_str)
            .is_some_and(|text| text.trim_start().starts_with('/'));
        if !command {
            if let Some(text) = self.instructions.lock().unwrap().take() {
                blocks.insert(0, json!({ "type": "text", "text": super::updates::wrap_instructions(text) }));
            }
        }
        {
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
            self.user_stopped.store(false, Ordering::SeqCst);
            let turn_id = uuid::Uuid::new_v4().to_string();
            let plan = self.wanted.lock().unwrap().plan;
            {
                let mut map = self.map.lock().unwrap();
                map.begin_turn(&turn_id);
                map.plan_mode = plan;
            }
            let _ = self.events.send(SessionEventBody::StatusChanged {
                status: SessionStatus::Running,
            });
            let _ = self.events.send(SessionEventBody::TurnAnchor {
                turn_id,
                mode: plan.then(|| "plan".to_string()),
            });
        }
        let shared = self.clone();
        tokio::spawn(async move {
            if let Err(err) = shared.apply_settings(&session_id).await {
                let _ = shared.events.send(SessionEventBody::Error {
                    message: err.to_string(),
                });
            }
            let result = shared
                .rpc
                .request(
                    "session/prompt",
                    json!({ "sessionId": session_id, "prompt": blocks }),
                    None,
                )
                .await;
            shared.finish(result);
        });
        Ok(TurnDelivery::Started)
    }

    /// 发消息前把模式、模型、强度和 Fast 对齐到用户的选择。只发有变化的项。
    async fn apply_settings(&self, session_id: &str) -> Result<(), AgentError> {
        let (plan, model, effort, fast) = {
            let wanted = self.wanted.lock().unwrap();
            (wanted.plan, wanted.model.clone(), wanted.effort.clone(), wanted.fast)
        };
        if plan != self.applied_plan.load(Ordering::SeqCst) {
            let mode = if plan { "plan" } else { "agent" };
            self.call(
                "session/set_mode",
                json!({ "sessionId": session_id, "modeId": mode }),
                Some(SETTING),
            )
            .await?;
            self.applied_plan.store(plan, Ordering::SeqCst);
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
        if let Some(options) = catalog::config_options(&reply) {
            self.adopt_config(&options);
        }
        Ok(())
    }

    fn finish(&self, result: Result<Result<Value, RpcError>, AgentError>) {
        let _guard = self.status_lock.lock().unwrap();
        self.busy.store(false, Ordering::SeqCst);
        let stopped = self.user_stopped.swap(false, Ordering::SeqCst);
        let left: Vec<String> = self.prompts.lock().unwrap().drain().map(|(id, _)| id).collect();
        for id in left {
            let _ = self.events.send(SessionEventBody::PromptResolved {
                prompt_id: id,
                answer: "已结束".into(),
            });
        }
        // 回合以 `Error: …` 收尾：Cursor 当成回答发出来的后端报错，算失败。
        let backend_error = self.map.lock().unwrap().take_error();
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
                        message: super::updates::error_message(backend_error.as_deref().unwrap_or("")),
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
            for event in self.subagents.lock().unwrap().stop_all() {
                let _ = self.events.send(event);
            }
        }
        let _ = self.events.send(SessionEventBody::StatusChanged { status });
    }

    /// `session/cancel`。Cursor 会把这一轮的 `session/prompt` 以 `stopReason = cancelled` 收尾。
    /// 没回答的审批要先回 `cancelled`（ACP 规定）。
    pub fn interrupt(&self) -> Result<(), AgentError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(AgentError::Closed);
        }
        let Some(session_id) = self.session_id() else {
            return Ok(());
        };
        {
            let _guard = self.status_lock.lock().unwrap();
            if !self.busy.load(Ordering::SeqCst) {
                return Ok(());
            }
            self.user_stopped.store(true, Ordering::SeqCst);
            let pending: Vec<(String, Value)> = self
                .prompts
                .lock()
                .unwrap()
                .drain()
                .map(|(id, (rpc_id, _))| (id, rpc_id))
                .collect();
            for (id, rpc_id) in pending {
                let _ = self.rpc.respond(&rpc_id, prompts::cancelled());
                let _ = self.events.send(SessionEventBody::PromptResolved {
                    prompt_id: id,
                    answer: "已中断".into(),
                });
            }
        }
        self.rpc
            .notify("session/cancel", json!({ "sessionId": session_id }))
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
        let access = if mode == "full" { "full" } else { "ask" };
        *self.access.lock().unwrap() = access.to_string();
    }

    pub fn current_access(&self) -> String {
        self.access.lock().unwrap().clone()
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
        for event in self.subagents.lock().unwrap().stop_all() {
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
    }
}

/// 工作台 MCP 按 ACP 的 `McpServerHttp` 写进 `session/new` / `session/load`。Cursor 声明了
/// `mcpCapabilities.http`，按会话加载，不动用户自己配的 MCP（`3635.index.js` 里 `mcpServers` 的解析）。
fn mcp_servers(mcp: Option<&WorkbenchMcp>) -> Value {
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
