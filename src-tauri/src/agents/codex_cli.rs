//! Codex CLI 适配器。
//!
//! `codex exec --json` 是一次性 JSONL，审批没有回写通道。工作台改为拉起
//! `codex app-server`（stdio 上按行分隔的 JSON-RPC，Codex 0.162 的当前协议）：
//! 工作目录是项目路径，stdout 事件映射为时间线，审批请求的 JSON-RPC 回复写回 stdin。
//!
//! 权限档位：
//! - 完全访问 → sandbox `danger-full-access`，approval `never`
//! - 询问批准 → sandbox `workspace-write`，approval `on-request`
//! - 只读     → sandbox `read-only`，approval `on-request`（越界仍会询问）

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

use crate::models::{
    strip_verbatim_prefix, AgentCatalog, AgentKind, AgentModelOption, AgentSkillOption, PromptKind,
    PromptOption, ReasoningEffortOption, SessionEventBody, SessionStatus,
};

use super::{AgentAdapter, AgentError, AgentSession, EventSink, SessionContext};

const RPC_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Access {
    Full,
    Ask,
    ReadOnly,
}

impl Access {
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "full" | "danger-full-access" | "full-access" | "完全访问" => Some(Self::Full),
            "ask" | "on-request" | "workspace-write" | "auto" | "询问批准" => Some(Self::Ask),
            "read-only" | "readonly" | "read" | "只读" => Some(Self::ReadOnly),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Full => "完全访问",
            Self::Ask => "询问批准",
            Self::ReadOnly => "只读",
        }
    }

    /// `thread/start` 的 sandbox 字符串。
    fn sandbox_mode(self) -> &'static str {
        match self {
            Self::Full => "danger-full-access",
            Self::Ask => "workspace-write",
            Self::ReadOnly => "read-only",
        }
    }

    fn approval_policy(self) -> &'static str {
        match self {
            Self::Full => "never",
            Self::Ask | Self::ReadOnly => "on-request",
        }
    }

    /// `turn/start` 的 sandboxPolicy 对象（camelCase）。
    fn sandbox_policy(self) -> Value {
        match self {
            Self::Full => json!({ "type": "dangerFullAccess" }),
            Self::Ask => json!({ "type": "workspaceWrite", "networkAccess": false }),
            Self::ReadOnly => json!({ "type": "readOnly", "networkAccess": false }),
        }
    }
}

#[derive(Clone)]
enum Pending {
    Approval { rpc_id: u64 },
    UserInput { rpc_id: u64, question_ids: Vec<String> },
    Access,
}

struct StreamBuf {
    text: String,
    last_emit: Instant,
}

struct Shared {
    events: EventSink,
    out: mpsc::UnboundedSender<String>,
    child: Mutex<Option<Child>>,
    next_id: AtomicU64,
    closed: AtomicBool,
    user_stop: AtomicBool,
    turn_open: AtomicBool,
    access: Mutex<Access>,
    model_override: Mutex<Option<String>>,
    effort: Mutex<Option<String>>,
    skills: Mutex<Vec<KnownSkill>>,
    thread_id: Mutex<Option<String>>,
    model: Mutex<String>,
    version: Mutex<String>,
    cwd: String,
    pending: Mutex<HashMap<String, Pending>>,
    waiters: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    /// 不等待结果的 JSON-RPC id → method，用来区分 turn/start 失败和其它命令失败。
    rpc_methods: Mutex<HashMap<u64, String>>,
    streams: Mutex<HashMap<String, StreamBuf>>,
}

pub struct CodexCliAdapter;

impl Default for CodexCliAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexCliAdapter {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl AgentAdapter for CodexCliAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::CodexCli
    }

    async fn detect(&self) -> Result<(), AgentError> {
        resolve_codex_bin().map(|_| ())
    }

    async fn start_session(
        &self,
        ctx: SessionContext,
        events: EventSink,
    ) -> Result<Arc<dyn AgentSession>, AgentError> {
        let bin = resolve_codex_bin()?;
        let version = codex_version(&bin).await;
        let mut command = Command::new(&bin);
        command
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        hide_console(&mut command);
        let mut child = command.spawn().map_err(|e| {
            AgentError::Runtime(format!("无法启动 Codex CLI（{}）：{e}", bin.display()))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AgentError::Runtime("Codex CLI 没有标准输入".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AgentError::Runtime("Codex CLI 没有标准输出".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AgentError::Runtime("Codex CLI 没有标准错误".into()))?;

        let initial_access = ctx
            .access_mode
            .as_deref()
            .and_then(Access::parse)
            .unwrap_or(Access::Full);
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(line) = out_rx.recv().await {
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

        let shared = Arc::new(Shared {
            events: events.clone(),
            out: out_tx,
            child: Mutex::new(Some(child)),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            user_stop: AtomicBool::new(false),
            turn_open: AtomicBool::new(false),
            access: Mutex::new(initial_access),
            model_override: Mutex::new(None),
            effort: Mutex::new(None),
            skills: Mutex::new(Vec::new()),
            thread_id: Mutex::new(None),
            model: Mutex::new(String::new()),
            version: Mutex::new(version.clone()),
            cwd: strip_verbatim_prefix(&ctx.project_path),
            pending: Mutex::new(HashMap::new()),
            waiters: Mutex::new(HashMap::new()),
            rpc_methods: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
        });

        let reader = Arc::clone(&shared);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => reader.handle_line(&line),
                    Ok(None) => {
                        reader.on_exit();
                        break;
                    }
                    Err(err) => {
                        emit(
                            &reader.events,
                            SessionEventBody::Error {
                                message: format!("读取 Codex 输出失败：{err}"),
                            },
                        );
                        reader.on_exit();
                        break;
                    }
                }
            }
        });

        let err_events = events.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.contains("unrecognized configuration") {
                    continue;
                }
                if trimmed.contains("ERROR") {
                    let message = truncate(trimmed, 300);
                    let body = if trimmed.contains("rmcp::") || trimmed.contains("mcp") {
                        SessionEventBody::System {
                            text: format!("MCP 连接提示：{message}"),
                        }
                    } else {
                        SessionEventBody::Error { message }
                    };
                    emit(&err_events, body);
                }
            }
        });

        if let Err(err) = shared
            .request(
                "initialize",
                json!({
                    "clientInfo": { "name": "ai-workbench", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "experimentalApi": true }
                }),
            )
            .await
        {
            shared.stop();
            return Err(err);
        }
        let _ = shared.notify("initialized", json!({}));

        emit(
            &events,
            SessionEventBody::System {
                text: format!(
                    "Codex CLI {version} 已连接（目录 {}）。权限：{}（sandbox {} / approval {}）。斜杠命令输入 / 查看，例如 /permissions、/status、/diff。",
                    ctx.project_path,
                    initial_access.label(),
                    initial_access.sandbox_mode(),
                    initial_access.approval_policy(),
                ),
            },
        );
        emit(
            &events,
            SessionEventBody::StatusChanged {
                status: SessionStatus::Completed,
            },
        );
        Ok(Arc::new(CodexCliSession { shared }))
    }
}

struct CodexCliSession {
    shared: Arc<Shared>,
}

#[async_trait]
impl AgentSession for CodexCliSession {
    async fn send_message(&self, text: String) -> Result<(), AgentError> {
        self.shared.ensure_open()?;
        if text.starts_with('/') {
            return self.shared.handle_slash(text.trim()).await;
        }
        self.shared.begin_turn(text).await
    }

    async fn answer_prompt(&self, prompt_id: &str, answer: String) -> Result<(), AgentError> {
        self.shared.ensure_open()?;
        let pending = self
            .shared
            .pending
            .lock()
            .unwrap()
            .remove(prompt_id)
            .ok_or_else(|| AgentError::UnknownPrompt(prompt_id.to_string()))?;
        match pending {
            Pending::Access => {
                let Some(access) = Access::parse(&answer) else {
                    return Err(AgentError::Runtime(
                        "请选择完全访问、询问批准或只读".into(),
                    ));
                };
                *self.shared.access.lock().unwrap() = access;
                self.shared.note_access();
            }
            Pending::Approval { rpc_id } => {
                let decision = if is_accept(&answer) { "accept" } else { "decline" };
                self.shared.respond(rpc_id, json!({ "decision": decision }));
                if self.shared.turn_open.load(Ordering::SeqCst) {
                    emit_status(&self.shared.events, SessionStatus::Running);
                }
            }
            Pending::UserInput {
                rpc_id,
                question_ids,
            } => {
                let mut answers = serde_json::Map::new();
                for id in question_ids {
                    answers.insert(id, json!({ "answers": [answer.clone()] }));
                }
                self.shared
                    .respond(rpc_id, json!({ "answers": answers }));
                if self.shared.turn_open.load(Ordering::SeqCst) {
                    emit_status(&self.shared.events, SessionStatus::Running);
                }
            }
        }
        Ok(())
    }

    async fn stop(&self) -> Result<(), AgentError> {
        self.shared.stop();
        Ok(())
    }

    fn set_access_mode(&self, mode: &str) -> Result<(), AgentError> {
        let access = Access::parse(mode).ok_or_else(|| {
            AgentError::Runtime(format!("未知权限档位：{mode}"))
        })?;
        let mut slot = self.shared.access.lock().unwrap();
        if *slot == access {
            return Ok(());
        }
        *slot = access;
        drop(slot);
        self.shared.note_access();
        Ok(())
    }

    async fn catalog(&self) -> Result<AgentCatalog, AgentError> {
        self.shared.catalog().await
    }

    fn set_tuning(&self, model: Option<String>, effort: Option<String>) -> Result<(), AgentError> {
        self.shared.set_tuning(model, effort);
        Ok(())
    }

    fn retarget(&self, kind: AgentKind) {
        if kind != AgentKind::CodexCli {
            emit(
                &self.shared.events,
                SessionEventBody::System {
                    text: "此会话已连接 Codex CLI。要使用 Claude Code，请新建会话。".into(),
                },
            );
        }
    }
}

impl Shared {
    fn ensure_open(&self) -> Result<(), AgentError> {
        if self.closed.load(Ordering::SeqCst) {
            Err(AgentError::Closed)
        } else {
            Ok(())
        }
    }

    fn note_access(&self) {
        let access = *self.access.lock().unwrap();
        emit(
            &self.events,
            SessionEventBody::System {
                text: format!(
                    "权限已设为{}（sandbox {} / approval {}）。下一条消息起生效。",
                    access.label(),
                    access.sandbox_mode(),
                    access.approval_policy(),
                ),
            },
        );
    }

    async fn begin_turn(&self, text: String) -> Result<(), AgentError> {
        if !self.pending.lock().unwrap().is_empty() {
            return Err(AgentError::PendingPrompt);
        }
        if self.turn_open.load(Ordering::SeqCst) {
            return Err(AgentError::Busy);
        }
        emit_status(&self.events, SessionStatus::Running);
        self.ensure_thread().await?;
        let thread_id = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Runtime("Codex 线程未建立".into()))?;
        let access = *self.access.lock().unwrap();
        if self.skills.lock().unwrap().is_empty() {
            if let Err(err) = self.refresh_skills().await {
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: format!("读取技能列表失败，本次按普通文本发送：{err}"),
                    },
                );
            }
        }
        let (input, skill_labels) = {
            let skills = self.skills.lock().unwrap();
            build_turn_input(&text, &skills)
        };
        if !skill_labels.is_empty() {
            emit(
                &self.events,
                SessionEventBody::System {
                    text: format!("已引用技能 {}。", skill_labels.join("、")),
                },
            );
        }
        let mut params = json!({
            "threadId": thread_id,
            "input": input,
            "approvalPolicy": access.approval_policy(),
            "sandboxPolicy": access.sandbox_policy(),
        });
        if let Some(model) = self.model_override.lock().unwrap().clone() {
            params["model"] = json!(model);
        }
        if let Some(effort) = self.effort.lock().unwrap().clone() {
            params["effort"] = json!(effort);
        }
        self.turn_open.store(true, Ordering::SeqCst);
        if !self.write_method("turn/start", params) {
            self.turn_open.store(false, Ordering::SeqCst);
            return Err(AgentError::Runtime("无法向 Codex CLI 写入消息".into()));
        }
        Ok(())
    }

    async fn ensure_thread(&self) -> Result<(), AgentError> {
        if self.thread_id.lock().unwrap().is_some() {
            return Ok(());
        }
        emit(
            &self.events,
            SessionEventBody::System {
                text: "正在启动 Codex 线程…".into(),
            },
        );
        let access = *self.access.lock().unwrap();
        let result = self
            .request(
                "thread/start",
                json!({
                    "cwd": self.cwd,
                    "approvalPolicy": access.approval_policy(),
                    "sandbox": access.sandbox_mode(),
                    "ephemeral": true,
                }),
            )
            .await?;
        let thread_id = result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if thread_id.is_empty() {
            return Err(AgentError::Runtime("Codex 没有返回线程 id".into()));
        }
        if let Some(model) = result
            .get("model")
            .and_then(Value::as_str)
            .or_else(|| result.pointer("/thread/model").and_then(Value::as_str))
        {
            *self.model.lock().unwrap() = model.to_string();
        }
        *self.thread_id.lock().unwrap() = Some(thread_id);
        Ok(())
    }

    async fn handle_slash(&self, text: &str) -> Result<(), AgentError> {
        let (name, rest) = split_command(text);
        match name.as_str() {
            "help" => {
                emit(
                    &self.events,
                    SessionEventBody::System { text: slash_help() },
                );
            }
            "permissions" | "approvals" => {
                if rest.is_empty() {
                    self.ask_access();
                } else if let Some(access) = Access::parse(&rest) {
                    *self.access.lock().unwrap() = access;
                    self.note_access();
                } else {
                    return Err(AgentError::Runtime(
                        "用法：/permissions 完全访问 | 询问批准 | 只读".into(),
                    ));
                }
            }
            "status" => self.emit_status_card(),
            "diff" => self.emit_diff().await,
            "model" => {
                if rest.is_empty() {
                    let model = self.model.lock().unwrap().clone();
                    let shown = if model.is_empty() { "（线程尚未启动）" } else { &model };
                    emit(
                        &self.events,
                        SessionEventBody::System {
                            text: format!("当前模型：{shown}。用法：/model <模型 id>"),
                        },
                    );
                } else {
                    *self.model_override.lock().unwrap() = Some(rest.to_string());
                    emit(
                        &self.events,
                        SessionEventBody::System {
                            text: format!("下一条消息将使用模型 {rest}。"),
                        },
                    );
                }
            }
            "review" => {
                let prompt = if rest.is_empty() {
                    "Review the current working tree. Focus on behavior changes, bugs, and missing tests. Do not modify files.".into()
                } else {
                    format!("Review the current working tree. {rest}")
                };
                self.begin_turn(prompt).await?;
            }
            "plan" => {
                let prompt = if rest.is_empty() {
                    "Switch to plan mode. Propose an execution plan only. Do not edit files or run mutating commands.".into()
                } else {
                    format!("Plan only. Do not edit files or run mutating commands.\n\n{rest}")
                };
                self.begin_turn(prompt).await?;
            }
            "compact" => {
                self.ensure_thread().await?;
                let thread_id = self.thread_id.lock().unwrap().clone().unwrap_or_default();
                let _ = self.write_method("thread/compact/start", json!({ "threadId": thread_id }));
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: "已请求压缩当前 Codex 线程的上下文。".into(),
                    },
                );
            }
            "approve" => {
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: "重试自动审查拒绝需要 Codex 附带的审查事件。工作台没有保存到这样的事件，请在时间线上点「允许」或「拒绝」。".into(),
                    },
                );
            }
            "new" | "clear" => {
                *self.thread_id.lock().unwrap() = None;
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: "已放下当前 Codex 线程。下一条消息会开一个新线程。".into(),
                    },
                );
            }
            "quit" | "exit" | "stop" => self.stop(),
            "init" => {
                self.begin_turn(
                    "Create an AGENTS.md scaffold for this repository if one does not already exist. Keep it short and specific to the code you can see.".into(),
                )
                .await?;
            }
            _ => {
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: format!(
                            "/{name} 是 Codex 终端里的命令，工作台不会把它当成给模型的提示。输入 /help 查看这里能执行的命令。"
                        ),
                    },
                );
            }
        }
        Ok(())
    }

    fn ask_access(&self) {
        let prompt_id = "local-access".to_string();
        self.pending
            .lock()
            .unwrap()
            .insert(prompt_id.clone(), Pending::Access);
        emit(
            &self.events,
            SessionEventBody::Prompt {
                prompt_id,
                prompt_kind: PromptKind::Choice,
                question: "选择 Codex 权限。完全访问对应 danger-full-access；询问批准对应 workspace-write + on-request；只读对应 read-only。".into(),
                options: vec![
                    PromptOption { id: "full".into(), label: "完全访问".into() },
                    PromptOption { id: "ask".into(), label: "询问批准".into() },
                    PromptOption { id: "read-only".into(), label: "只读".into() },
                ],
            },
        );
        emit_status(&self.events, SessionStatus::NeedsInput);
    }

    fn emit_status_card(&self) {
        let access = *self.access.lock().unwrap();
        let model = self.model.lock().unwrap().clone();
        let thread = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "（尚未开始）".into());
        let version = self.version.lock().unwrap().clone();
        emit(
            &self.events,
            SessionEventBody::System {
                text: format!(
                    "Codex {version}\n模型：{}\n线程：{thread}\n目录：{}\n权限：{}（sandbox {} / approval {}）",
                    if model.is_empty() { "（尚未开始）" } else { &model },
                    self.cwd,
                    access.label(),
                    access.sandbox_mode(),
                    access.approval_policy(),
                ),
            },
        );
    }

    async fn emit_diff(&self) {
        let mut git = Command::new("git");
        git.arg("-C")
            .arg(&self.cwd)
            .arg("diff")
            .arg("--stat")
            .arg("HEAD");
        hide_console(&mut git);
        let output = git.output().await;
        let text = match output {
            Ok(output) if output.status.success() => {
                let mut body = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if body.is_empty() {
                    body = "工作区相对 HEAD 没有差异。".into();
                }
                if body.chars().count() > 4000 {
                    body = body.chars().take(4000).collect();
                    body.push_str("\n…");
                }
                body
            }
            Ok(output) => {
                let err = String::from_utf8_lossy(&output.stderr);
                format!("无法读取 git diff：{}", err.trim())
            }
            Err(err) => format!("无法运行 git：{err}"),
        };
        emit(&self.events, SessionEventBody::System { text });
    }

    fn stop(&self) {
        if self.user_stop.swap(true, Ordering::SeqCst) {
            return;
        }
        self.closed.store(true, Ordering::SeqCst);
        self.turn_open.store(false, Ordering::SeqCst);
        if let Some(thread_id) = self.thread_id.lock().unwrap().clone() {
            let _ = self.write_method("turn/interrupt", json!({ "threadId": thread_id }));
        }
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.start_kill();
        }
        emit_status(&self.events, SessionStatus::Stopped);
    }

    fn on_exit(&self) {
        if self.user_stop.load(Ordering::SeqCst) || self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.turn_open.store(false, Ordering::SeqCst);
        emit(
            &self.events,
            SessionEventBody::Error {
                message: "Codex CLI 进程已退出。".into(),
            },
        );
        emit_status(&self.events, SessionStatus::Failed);
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, AgentError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.waiters.lock().unwrap().insert(id, tx);
        if !self.write_rpc(id, method, params) {
            self.waiters.lock().unwrap().remove(&id);
            return Err(AgentError::Runtime("无法向 Codex CLI 写入消息".into()));
        }
        match timeout(RPC_TIMEOUT, rx).await {
            Ok(Ok(message)) => {
                if let Some(err) = message.get("error") {
                    Err(AgentError::Runtime(rpc_error_text(err)))
                } else {
                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                }
            }
            _ => Err(AgentError::Runtime(format!("等待 Codex {method} 超时"))),
        }
    }

    fn write_method(&self, method: &str, params: Value) -> bool {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.rpc_methods
            .lock()
            .unwrap()
            .insert(id, method.to_string());
        self.write_rpc(id, method, params)
    }

    fn notify(&self, method: &str, params: Value) -> bool {
        let line = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        })
        .to_string();
        self.out.send(line).is_ok()
    }

    fn write_rpc(&self, id: u64, method: &str, params: Value) -> bool {
        let line = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        })
        .to_string();
        self.out.send(line).is_ok()
    }

    fn respond(&self, id: u64, result: Value) {
        let line = json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string();
        let _ = self.out.send(line);
    }

    fn respond_error(&self, id: u64, message: &str) {
        let line = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": message }
        })
        .to_string();
        let _ = self.out.send(line);
    }

    fn handle_line(&self, line: &str) {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            if message.get("method").is_some() {
                self.handle_server_request(id, &message);
                return;
            }
            if let Some(waiter) = self.waiters.lock().unwrap().remove(&id) {
                let _ = waiter.send(message);
            } else {
                let method = self.rpc_methods.lock().unwrap().remove(&id);
                if let Some(err) = message.get("error") {
                    let text = rpc_error_text(err);
                    if method.as_deref() == Some("turn/start") {
                        self.turn_open.store(false, Ordering::SeqCst);
                        emit(
                            &self.events,
                            SessionEventBody::Error { message: text },
                        );
                        emit_status(&self.events, SessionStatus::Failed);
                    } else {
                        let label = method.unwrap_or_else(|| "请求".into());
                        emit(
                            &self.events,
                            SessionEventBody::System {
                                text: format!("Codex {label} 失败：{text}"),
                            },
                        );
                    }
                }
            }
            return;
        }
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            self.handle_notification(method, &params);
        }
    }

    fn handle_server_request(&self, id: u64, message: &Value) {
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let prompt_id = id.to_string();
        match method {
            "currentTime/read" => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                self.respond(id, json!({ "currentTimeAt": now }));
            }
            "item/tool/call" => {
                let tool = params
                    .pointer("/tool")
                    .and_then(Value::as_str)
                    .or_else(|| params.get("name").and_then(Value::as_str))
                    .unwrap_or("tool");
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: format!("已拒绝客户端工具 {tool}。Codex 自己的命令和补丁仍走审批。"),
                    },
                );
                self.respond(
                    id,
                    json!({
                        "success": false,
                        "contentItems": [{
                            "type": "inputText",
                            "text": "ai-workbench 不执行客户端动态工具。"
                        }]
                    }),
                );
            }
            "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval" => {
                let question = approval_question(method, &params);
                self.pending
                    .lock()
                    .unwrap()
                    .insert(prompt_id.clone(), Pending::Approval { rpc_id: id });
                emit(
                    &self.events,
                    SessionEventBody::Prompt {
                        prompt_id,
                        prompt_kind: PromptKind::Approval,
                        question,
                        options: vec![
                            PromptOption { id: "approve".into(), label: "允许".into() },
                            PromptOption { id: "reject".into(), label: "拒绝".into() },
                        ],
                    },
                );
                emit_status(&self.events, SessionStatus::NeedsInput);
            }
            "item/tool/requestUserInput" => {
                let questions = params
                    .get("questions")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let question_ids: Vec<String> = questions
                    .iter()
                    .filter_map(|q| q.get("id").and_then(Value::as_str).map(str::to_string))
                    .collect();
                let (prompt_kind, question, options) = user_input_prompt(&questions);
                self.pending.lock().unwrap().insert(
                    prompt_id.clone(),
                    Pending::UserInput {
                        rpc_id: id,
                        question_ids,
                    },
                );
                emit(
                    &self.events,
                    SessionEventBody::Prompt {
                        prompt_id,
                        prompt_kind,
                        question,
                        options,
                    },
                );
                emit_status(&self.events, SessionStatus::NeedsInput);
            }
            _ => {
                self.respond_error(id, "ai-workbench 未处理该 Codex 请求");
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: format!("已跳过 Codex 请求 {method}。"),
                    },
                );
            }
        }
    }

    fn handle_notification(&self, method: &str, params: &Value) {
        match method {
            "turn/started" => {
                self.turn_open.store(true, Ordering::SeqCst);
                emit_status(&self.events, SessionStatus::Running);
            }
            "turn/completed" => {
                self.turn_open.store(false, Ordering::SeqCst);
                if let Some(message) = params.pointer("/turn/error").and_then(error_text) {
                    emit(&self.events, SessionEventBody::Error { message });
                    emit_status(&self.events, SessionStatus::Failed);
                } else if self.pending.lock().unwrap().is_empty() {
                    emit_status(&self.events, SessionStatus::Completed);
                }
            }
            "item/agentMessage/delta" => {
                let Some(item_id) = params.get("itemId").and_then(Value::as_str) else {
                    return;
                };
                let delta = params.get("delta").and_then(Value::as_str).unwrap_or("");
                self.push_stream(item_id, delta, false);
            }
            "item/started" | "item/completed" => {
                let Some(item) = params.get("item") else { return };
                self.handle_item(method == "item/completed", item);
            }
            "error" => {
                if let Some(message) = params.get("message").and_then(Value::as_str) {
                    self.turn_open.store(false, Ordering::SeqCst);
                    emit(
                        &self.events,
                        SessionEventBody::Error {
                            message: message.to_string(),
                        },
                    );
                    emit_status(&self.events, SessionStatus::Failed);
                }
            }
            "thread/compacted" => {
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: "Codex 已压缩当前线程的上下文。".into(),
                    },
                );
            }
            _ => {}
        }
    }

    fn handle_item(&self, completed: bool, item: &Value) {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
        let id = item.get("id").and_then(Value::as_str).unwrap_or("");
        match kind {
            "agentMessage" => {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    if !id.is_empty() {
                        self.streams.lock().unwrap().insert(
                            id.to_string(),
                            StreamBuf {
                                text: String::new(),
                                last_emit: Instant::now(),
                            },
                        );
                        self.push_stream(id, text, true);
                    } else if !text.is_empty() {
                        emit(
                            &self.events,
                            SessionEventBody::AgentMessage {
                                text: text.to_string(),
                                stream_id: None,
                            },
                        );
                    }
                }
            }
            "commandExecution" => {
                let command = item.get("command").and_then(Value::as_str).unwrap_or("");
                if !completed {
                    emit(
                        &self.events,
                        SessionEventBody::ToolCall {
                            name: "command".into(),
                            summary: truncate(command, 180),
                        },
                    );
                    return;
                }
                let status = item.get("status").and_then(Value::as_str).unwrap_or("");
                let exit = item
                    .get("exitCode")
                    .and_then(Value::as_i64)
                    .map(|code| format!("，退出码 {code}"))
                    .unwrap_or_default();
                let output = item
                    .get("aggregatedOutput")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let mut summary = format!("{command} → {status}{exit}");
                if !output.is_empty() {
                    summary.push_str("\n");
                    summary.push_str(&truncate(output, 240));
                }
                emit(
                    &self.events,
                    SessionEventBody::ToolCall {
                        name: "command".into(),
                        summary,
                    },
                );
            }
            "fileChange" if completed => {
                let changes = item
                    .get("changes")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter_map(|change| change.get("path").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("、")
                    })
                    .unwrap_or_default();
                let status = item.get("status").and_then(Value::as_str).unwrap_or("");
                emit(
                    &self.events,
                    SessionEventBody::ToolCall {
                        name: "apply_patch".into(),
                        summary: format!("{status} {changes}").trim().to_string(),
                    },
                );
            }
            "mcpToolCall" if !completed => {
                let tool = item.get("tool").and_then(Value::as_str).unwrap_or("mcp");
                let server = item.get("server").and_then(Value::as_str).unwrap_or("");
                emit(
                    &self.events,
                    SessionEventBody::ToolCall {
                        name: tool.to_string(),
                        summary: format!("MCP {server}"),
                    },
                );
            }
            "webSearch" if !completed => {
                let query = item.get("query").and_then(Value::as_str).unwrap_or("");
                emit(
                    &self.events,
                    SessionEventBody::ToolCall {
                        name: "web_search".into(),
                        summary: query.to_string(),
                    },
                );
            }
            _ => {}
        }
    }

    fn push_stream(&self, item_id: &str, piece: &str, replace: bool) {
        let mut streams = self.streams.lock().unwrap();
        let buf = streams.entry(item_id.to_string()).or_insert_with(|| StreamBuf {
            text: String::new(),
            last_emit: Instant::now() - Duration::from_secs(1),
        });
        if replace {
            buf.text = piece.to_string();
        } else {
            buf.text.push_str(piece);
        }
        let due = replace
            || buf.last_emit.elapsed() >= Duration::from_millis(80)
            || buf.text.chars().count() % 48 < piece.chars().count();
        if !due || buf.text.is_empty() {
            return;
        }
        buf.last_emit = Instant::now();
        let text = buf.text.clone();
        drop(streams);
        emit(
            &self.events,
            SessionEventBody::AgentMessage {
                text,
                stream_id: Some(item_id.to_string()),
            },
        );
    }

    fn set_tuning(&self, model: Option<String>, effort: Option<String>) {
        if let Some(model) = model {
            let trimmed = model.trim();
            *self.model_override.lock().unwrap() = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            };
        }
        if let Some(effort) = effort {
            let trimmed = effort.trim();
            *self.effort.lock().unwrap() = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            };
        }
    }

    async fn catalog(&self) -> Result<AgentCatalog, AgentError> {
        let models = self
            .request("model/list", json!({ "includeHidden": true }))
            .await?;
        self.refresh_skills().await?;
        let skills = self
            .skills
            .lock()
            .unwrap()
            .iter()
            .map(|skill| AgentSkillOption {
                name: skill.name.clone(),
                mention: skill.mention.clone(),
                label: skill.label.clone(),
                description: skill.description.clone(),
                path: skill.path.clone(),
            })
            .collect();
        Ok(AgentCatalog {
            models: parse_models(&models),
            skills,
        })
    }

    async fn refresh_skills(&self) -> Result<(), AgentError> {
        let listed = self
            .request("skills/list", json!({ "cwd": self.cwd }))
            .await?;
        *self.skills.lock().unwrap() = parse_skills(&listed);
        Ok(())
    }
}

fn approval_question(method: &str, params: &Value) -> String {
    let reason = params.get("reason").and_then(Value::as_str).unwrap_or("");
    let command = params.get("command").and_then(Value::as_str).unwrap_or("");
    let title = match method {
        "item/fileChange/requestApproval" => "Codex 请求修改文件",
        "item/permissions/requestApproval" => "Codex 请求额外权限",
        _ => "Codex 请求执行命令",
    };
    let mut text = title.to_string();
    if !command.is_empty() {
        text.push_str("\n");
        text.push_str(command);
    }
    if command.is_empty() {
        if let Some(actions) = params.get("commandActions").and_then(Value::as_array) {
            let lines: Vec<&str> = actions
                .iter()
                .filter_map(|action| action.get("command").and_then(Value::as_str))
                .take(4)
                .collect();
            if !lines.is_empty() {
                text.push('\n');
                text.push_str(&lines.join("\n"));
            }
        }
    }
    if let Some(root) = params.get("grantRoot").and_then(Value::as_str) {
        if !root.is_empty() {
            text.push_str("\n写入根目录：");
            text.push_str(root);
        }
    }
    if !reason.is_empty() {
        text.push('\n');
        text.push_str(reason);
    }
    text
}

fn user_input_prompt(questions: &[Value]) -> (PromptKind, String, Vec<PromptOption>) {
    let first = questions.first();
    let question = questions
        .iter()
        .filter_map(|q| q.get("question").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    let options = first
        .and_then(|q| q.get("options").and_then(Value::as_array))
        .map(|list| {
            list.iter()
                .filter_map(|opt| {
                    let label = opt.get("label").and_then(Value::as_str)?;
                    let id = opt
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or(label)
                        .to_string();
                    Some(PromptOption {
                        id,
                        label: label.to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if questions.len() == 1 && !options.is_empty() {
        (PromptKind::Choice, question, options)
    } else {
        (PromptKind::FreeText, question, Vec::new())
    }
}

fn error_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        other => {
            let text = other.to_string();
            if text == "null" || text == "{}" {
                None
            } else {
                Some(text)
            }
        }
    }
}

fn rpc_error_text(err: &Value) -> String {
    err.get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("Codex 返回错误：{err}"))
}

fn is_accept(answer: &str) -> bool {
    matches!(
        answer.trim(),
        "approve" | "accept" | "允许" | "yes" | "y"
    )
}

fn slash_help() -> String {
    "可用斜杠命令：\n\
     /permissions [完全访问|询问批准|只读]  切换沙箱和审批\n\
     /status  查看模型、线程、目录和权限\n\
     /diff  查看 git diff --stat\n\
     /review [说明]  请 Codex 审查工作区\n\
     /plan [说明]  只出计划，不改文件\n\
     /model [模型 id]  指定下一轮模型\n\
     /compact  压缩上下文\n\
     /approve  说明如何处理自动审查拒绝（时间线上点允许或拒绝）\n\
     /init  生成 AGENTS.md\n\
     /new  下一条消息开新线程\n\
     /stop  停止会话\n\
     其余 /vim、/theme 等终端命令不会发给模型。"
        .into()
}

fn truncate(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(max).collect();
        out.push('…');
        out
    }
}

fn emit(events: &EventSink, body: SessionEventBody) {
    let _ = events.send(body);
}

fn emit_status(events: &EventSink, status: SessionStatus) {
    emit(events, SessionEventBody::StatusChanged { status });
}

fn resolve_codex_bin() -> Result<PathBuf, AgentError> {
    if let Some(path) = std::env::var_os("CODEX_BIN").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
    }
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_var) {
        let exe = dir.join("codex.exe");
        if exe.is_file() {
            return Ok(exe);
        }
    }
    for dir in std::env::split_paths(&path_var) {
        for name in ["codex.cmd", "codex.ps1", "codex"] {
            let shim = dir.join(name);
            if shim.is_file() {
                if let Some(found) = vendor_exe_near(&shim) {
                    return Ok(found);
                }
            }
        }
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let candidate = PathBuf::from(appdata).join(
            "npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
        );
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(AgentError::Runtime(
        "未找到 Codex CLI。请先安装并确保 `codex` 在 PATH 中（例如 npm i -g @openai/codex）。".into(),
    ))
}

fn vendor_exe_near(shim: &Path) -> Option<PathBuf> {
    let parent = shim.parent()?;
    let rel = Path::new("node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
    let candidates = [parent.join(rel), parent.join("..").join(rel)];
    candidates.into_iter().find(|path| path.is_file())
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：GUI 宿主拉起控制台程序时不要弹出黑窗口。
        command.creation_flags(0x08000000);
    }
    let _ = command;
}

async fn codex_version(bin: &Path) -> String {
    let mut command = Command::new(bin);
    command.arg("--version");
    hide_console(&mut command);
    let Ok(output) = command.output().await else {
        return "未知版本".into();
    };
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .next()
        .unwrap_or("codex")
        .trim()
        .to_string()
}

#[derive(Clone)]
struct KnownSkill {
    name: String,
    mention: String,
    label: String,
    description: String,
    path: String,
}

fn parse_models(value: &Value) -> Vec<AgentModelOption> {
    let list = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut models = Vec::new();
    for item in list {
        if item.get("hidden").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let id = item
            .get("model")
            .and_then(Value::as_str)
            .or_else(|| item.get("id").and_then(Value::as_str))
            .unwrap_or("")
            .trim()
            .to_string();
        if id.is_empty() {
            continue;
        }
        let label = item
            .get("displayName")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .unwrap_or(&id)
            .to_string();
        let efforts = item
            .get("supportedReasoningEfforts")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|effort| {
                        let id = effort
                            .get("reasoningEffort")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        if id.is_empty() {
                            return None;
                        }
                        Some(ReasoningEffortOption {
                            description: effort
                                .get("description")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            id,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let default_effort = item
            .get("defaultReasoningEffort")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
            .or_else(|| efforts.first().map(|effort| effort.id.clone()))
            .unwrap_or_default();
        models.push(AgentModelOption {
            id,
            label,
            description: item
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            is_default: item.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
            default_effort,
            efforts,
        });
    }
    models.sort_by(|a, b| b.is_default.cmp(&a.is_default).then(a.label.cmp(&b.label)));
    models
}

fn parse_skills(value: &Value) -> Vec<KnownSkill> {
    let mut skills = Vec::new();
    collect_skills(value, &mut skills);
    skills
}

fn collect_skills(value: &Value, out: &mut Vec<KnownSkill>) {
    if let Some(list) = value.as_array() {
        for item in list {
            collect_skills(item, out);
        }
        return;
    }
    let Some(list) = value.get("skills").and_then(Value::as_array) else {
        return;
    };
    for skill in list {
        if skill.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let name = skill
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let path = skill
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() || path.is_empty() || out.iter().any(|item| item.path == path) {
            continue;
        }
        let mention = name.rsplit(':').next().unwrap_or(&name).to_string();
        let label = skill
            .pointer("/interface/displayName")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .unwrap_or(&mention)
            .to_string();
        out.push(KnownSkill {
            description: skill
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            name,
            mention,
            label,
            path,
        });
    }
}

fn is_skill_token(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
}

fn build_turn_input(text: &str, skills: &[KnownSkill]) -> (Value, Vec<String>) {
    let bytes = text.as_bytes();
    let mut elements = Vec::new();
    let mut labels = Vec::new();
    let mut attached: Vec<&KnownSkill> = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'$' {
            let start = index;
            let mut end = index + 1;
            while end < bytes.len() && is_skill_token(bytes[end]) {
                end += 1;
            }
            let token = &text[index + 1..end];
            if !token.is_empty() {
                if let Some(skill) = skills.iter().find(|skill| {
                    skill.mention.eq_ignore_ascii_case(token) || skill.name.eq_ignore_ascii_case(token)
                }) {
                    elements.push(json!({
                        "byteRange": { "start": start, "end": end },
                        "placeholder": skill.label,
                    }));
                    if !attached.iter().any(|item| item.path == skill.path) {
                        labels.push(skill.label.clone());
                        attached.push(skill);
                    }
                }
            }
            index = end;
            continue;
        }
        index += 1;
    }
    let mut text_item = json!({ "type": "text", "text": text });
    if !elements.is_empty() {
        text_item["text_elements"] = Value::Array(elements);
    }
    let mut input = vec![text_item];
    for skill in attached {
        input.push(json!({
            "type": "skill",
            "name": skill.name,
            "path": skill.path,
        }));
    }
    (Value::Array(input), labels)
}

fn split_command(text: &str) -> (String, String) {
    let body = text.trim().trim_start_matches('/');
    let mut parts = body.splitn(2, char::is_whitespace);
    let name = parts.next().unwrap_or("").to_ascii_lowercase();
    let rest = parts.next().unwrap_or("").trim().to_string();
    (name, rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_permission_labels() {
        assert_eq!(Access::parse("完全访问"), Some(Access::Full));
        assert_eq!(Access::parse("询问批准"), Some(Access::Ask));
        assert_eq!(Access::parse("read-only"), Some(Access::ReadOnly));
        assert_eq!(Access::Full.sandbox_mode(), "danger-full-access");
        assert_eq!(Access::Full.approval_policy(), "never");
        assert_eq!(Access::Ask.sandbox_mode(), "workspace-write");
        assert_eq!(Access::Ask.approval_policy(), "on-request");
        assert_eq!(
            Access::ReadOnly.sandbox_policy()["type"],
            json!("readOnly")
        );
    }

    #[test]
    fn attaches_skill_mentions() {
        let skills = vec![KnownSkill {
            name: "documents:documents".into(),
            mention: "documents".into(),
            label: "Documents".into(),
            description: String::new(),
            path: "C:/skills/documents/SKILL.md".into(),
        }];
        let (input, labels) = build_turn_input("请用 $documents 改合同", &skills);
        assert_eq!(labels, vec!["Documents".to_string()]);
        assert_eq!(input[1]["type"], json!("skill"));
        assert_eq!(input[1]["name"], json!("documents:documents"));
        assert_eq!(input[0]["text_elements"][0]["placeholder"], json!("Documents"));
    }

    #[test]
    fn reads_model_efforts() {
        let models = parse_models(&json!({
            "data": [{
                "model": "gpt-test",
                "displayName": "GPT Test",
                "hidden": false,
                "isDefault": true,
                "defaultReasoningEffort": "medium",
                "supportedReasoningEfforts": [
                    { "reasoningEffort": "low", "description": "fast" },
                    { "reasoningEffort": "medium", "description": "balanced" }
                ]
            }]
        }));
        assert_eq!(models[0].id, "gpt-test");
        assert_eq!(models[0].efforts.len(), 2);
        assert_eq!(models[0].default_effort, "medium");
    }

    #[test]
    fn splits_slash_args() {
        assert_eq!(
            split_command("/permissions 只读"),
            ("permissions".into(), "只读".into())
        );
    }

    #[tokio::test]
    #[ignore = "calls the local Codex CLI"]
    async fn catalog_lists_live_models() {
        let adapter = CodexCliAdapter::new();
        let (tx, _rx) = mpsc::unbounded_channel();
        let session = adapter
            .start_session(
                SessionContext {
                    session_id: "catalog".into(),
                    project_path: std::env::temp_dir().to_string_lossy().to_string(),
                    access_mode: Some("read-only".into()),
                },
                tx,
            )
            .await
            .expect("start");
        let catalog = session.catalog().await.expect("catalog");
        assert!(!catalog.models.is_empty(), "codex returned no models");
        assert!(
            catalog.models.iter().any(|model| !model.efforts.is_empty()),
            "codex returned no reasoning efforts"
        );
        let _ = session.stop().await;
    }

    #[tokio::test]
    #[ignore = "calls the local Codex CLI"]
    async fn smoke_readonly_turn() {
        let adapter = CodexCliAdapter::new();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let cwd = std::env::temp_dir();
        let session = adapter
            .start_session(
                SessionContext {
                    session_id: "smoke".into(),
                    project_path: cwd.to_string_lossy().to_string(),
                    access_mode: Some("read-only".into()),
                },
                tx,
            )
            .await
            .expect("start");
        session
            .send_message("Reply with exactly pong. Do not use tools.".into())
            .await
            .expect("send");

        let mut saw = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
        while tokio::time::Instant::now() < deadline {
            match timeout(Duration::from_secs(8), rx.recv()).await {
                Ok(Some(SessionEventBody::AgentMessage { text, .. })) => saw = text,
                Ok(Some(SessionEventBody::StatusChanged {
                    status: SessionStatus::Completed,
                })) if saw.to_ascii_lowercase().contains("pong") => {
                    let _ = session.stop().await;
                    return;
                }
                Ok(Some(SessionEventBody::StatusChanged {
                    status: SessionStatus::Failed,
                })) => panic!("turn failed, last message: {saw}"),
                Ok(Some(SessionEventBody::Error { message })) => panic!("codex error: {message}"),
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => {}
            }
        }
        let _ = session.stop().await;
        panic!("timed out waiting for pong, last message: {saw}");
    }
}
