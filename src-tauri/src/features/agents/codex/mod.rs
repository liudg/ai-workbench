//! Codex CLI 适配器。本文件只编排进程、RPC 和目录；协议细节在子模块里。
//!
//! `codex app-server`（stdio 上按行分隔的 JSON-RPC）：
//! 工作目录是项目路径，stdout 事件映射为时间线，审批请求的 JSON-RPC 回复写回 stdin。
//!
//! 权限档位：
//! - 完全访问 → sandbox `danger-full-access`，approval `never`
//! - 询问批准 → sandbox `workspace-write`，approval `on-request`
//! - 只读     → sandbox `read-only`，approval `on-request`（越界仍会询问）
//!
//! `options.persist == true` 时新线程写入官方 resume 列表。
//! `resume_native_id` 走 `thread/resume`。

mod catalog;
mod process;
mod prompts;
mod resume;
mod rpc;
mod state;
mod turn;

pub use resume::CodexDirectory;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::features::agents::install::CliRelease;
use crate::features::agents::{AgentAdapter, AgentError, AgentSession, EventSink, SessionContext};
use crate::encoding::{apply_utf8_env, decode_child_bytes};
use crate::models::{
    strip_verbatim_prefix, AgentCapabilities, AgentCatalog, AgentKind, AgentProfile, PromptAnswer,
    SessionEventBody, SessionStatus, OCCUPIED_SESSION_NOTICE,
};

use process::{
    apply_codex_network_env, classify_codex_stderr, codex_version, hide_console, resolve_codex_bin,
    trim_newline, StderrClass,
};
use prompts::{async_answer_text, blocking_answer_payload, is_accept, questions_summary};
use state::{emit, emit_status, Access, Pending, Shared};

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

pub(crate) fn locate_codex_bin() -> Option<PathBuf> {
    process::resolve_codex_bin().ok()
}

#[async_trait]
impl AgentAdapter for CodexCliAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::CodexCli
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::codex()
    }

    fn cli_release(&self) -> Option<CliRelease> {
        Some(CliRelease {
            bins: &["codex"],
            npm_package: "@openai/codex",
            self_update: &["update"],
            locate: Some(locate_codex_bin),
            version_args: &[],
            aliases: &[],
            note: "",
        })
    }

    fn profile(&self) -> AgentProfile {
        AgentProfile {
            kind: self.kind(),
            capabilities: self.capabilities(),
            commands: catalog::slash_commands(),
        }
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
        // 模型目录请求有 5 秒上限。直连 chatgpt.com 会超时；把系统代理写进
        // HTTP(S)_PROXY。回环地址仍进 NO_PROXY，避免 Clash 把本地 MCP 回成空 502。
        apply_codex_network_env(&mut command);
        apply_utf8_env(&mut command);
        hide_console(&mut command);
        apply_utf8_env(&mut command);
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
            persist: ctx.flag("persist"),
            turn_id: Mutex::new(None),
            model: Mutex::new(String::new()),
            version: Mutex::new(version),
            cwd: strip_verbatim_prefix(&ctx.project_path),
            pending: Mutex::new(HashMap::new()),
            waiters: Mutex::new(HashMap::new()),
            rpc_methods: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            message_phases: Mutex::new(HashMap::new()),
            titled: AtomicBool::new(false),
            question_items: Mutex::new(HashSet::new()),
            occupancy: Mutex::new(state::Occupancy::default()),
        });

        let reader = Arc::clone(&shared);
        tokio::spawn(async move {
            // 按字节读行再解码：单条 GBK（代码页 936）消息不会再中断 JSON-RPC 循环。
            let mut lines = BufReader::new(stdout);
            let mut raw = Vec::new();
            loop {
                raw.clear();
                match lines.read_until(b'\n', &mut raw).await {
                    Ok(0) => {
                        reader.on_exit();
                        break;
                    }
                    Ok(_) => {
                        trim_newline(&mut raw);
                        let line = decode_child_bytes(&raw);
                        reader.handle_line(&line);
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
            // 与 stdout 相同：按字节读行，GBK 日志行解码后继续，而不是静默结束读取。
            let mut lines = BufReader::new(stderr);
            let mut raw = Vec::new();
            let mut seen_notice = HashSet::new();
            loop {
                raw.clear();
                let Ok(n) = lines.read_until(b'\n', &mut raw).await else {
                    break;
                };
                if n == 0 {
                    break;
                }
                trim_newline(&mut raw);
                let line = decode_child_bytes(&raw);
                match classify_codex_stderr(&line) {
                    StderrClass::Ignore => {}
                    StderrClass::Error(message) => {
                        emit(&err_events, SessionEventBody::Error { message });
                    }
                    StderrClass::Notice(text) => {
                        if seen_notice.insert(text.clone()) {
                            emit(&err_events, SessionEventBody::System { text });
                        }
                    }
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

        if let Some(thread_id) = ctx
            .resume_native_id
            .clone()
            .filter(|id| !id.is_empty())
        {
            shared.restore_thread(&thread_id).await;
        } else if ctx.flag("persist") {
            if let Err(err) = shared.ensure_thread().await {
                shared.stop();
                return Err(err);
            }
        }

        // 写锁冲突只发一条只读通知，放在历史载入之后。打开本身仍然成功。
        shared.finish_open();
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
        if self.shared.read_only() {
            return Err(AgentError::Runtime(OCCUPIED_SESSION_NOTICE.into()));
        }
        if text.starts_with('/') {
            return self.shared.handle_slash(text.trim()).await;
        }
        self.shared.begin_turn(text).await
    }

    async fn answer_prompt(&self, prompt_id: &str, answer: PromptAnswer) -> Result<(), AgentError> {
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
                let PromptAnswer::Single { value } = &answer else {
                    return Err(AgentError::Runtime(
                        "请选择完全访问、询问批准或只读".into(),
                    ));
                };
                let Some(access) = Access::parse(value) else {
                    return Err(AgentError::Runtime(
                        "请选择完全访问、询问批准或只读".into(),
                    ));
                };
                *self.shared.access.lock().unwrap() = access;
                self.shared.resolve_prompt(prompt_id, value.clone());
                if self.shared.turn_open.load(Ordering::SeqCst) {
                    emit_status(&self.shared.events, SessionStatus::Running);
                } else {
                    emit_status(&self.shared.events, SessionStatus::Completed);
                }
            }
            Pending::Approval { rpc_id } => {
                let PromptAnswer::Single { value } = &answer else {
                    return Err(AgentError::Runtime("审批只接受允许或拒绝".into()));
                };
                let decision = if is_accept(value) { "accept" } else { "decline" };
                self.shared.respond(rpc_id, json!({ "decision": decision }));
                self.shared.resolve_prompt(prompt_id, value.clone());
                if self.shared.turn_open.load(Ordering::SeqCst) {
                    emit_status(&self.shared.events, SessionStatus::Running);
                }
            }
            Pending::UserInput { rpc_id, questions } => {
                let payload = blocking_answer_payload(&questions, &answer);
                self.shared.respond(rpc_id, payload);
                self.shared
                    .resolve_prompt(prompt_id, questions_summary(&questions, &answer));
                if self.shared.turn_open.load(Ordering::SeqCst) {
                    emit_status(&self.shared.events, SessionStatus::Running);
                }
            }
            Pending::AsyncQuestions { questions } => {
                let text = async_answer_text(&questions, &answer);
                let summary = questions_summary(&questions, &answer);
                if self.shared.turn_open.load(Ordering::SeqCst) {
                    if let Err(err) = self.shared.steer_turn(&text).await {
                        // 写回失败：恢复待答状态，卡片仍可操作
                        self.shared.pending.lock().unwrap().insert(
                            prompt_id.to_string(),
                            Pending::AsyncQuestions { questions },
                        );
                        return Err(err);
                    }
                    self.shared.resolve_prompt(prompt_id, summary);
                    emit_status(&self.shared.events, SessionStatus::Running);
                } else {
                    // 回合已结束（被打断或超时）：答案作为新回合发出去
                    self.shared.begin_turn(text).await?;
                    self.shared.resolve_prompt(prompt_id, summary);
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
        Ok(())
    }

    async fn catalog(&self) -> Result<AgentCatalog, AgentError> {
        self.shared.catalog().await
    }

    fn set_tuning(&self, model: Option<String>, effort: Option<String>) -> Result<(), AgentError> {
        self.shared.set_tuning(model, effort);
        Ok(())
    }

    fn native_id(&self) -> Option<String> {
        self.shared.thread_id.lock().unwrap().clone()
    }

    fn read_only(&self) -> bool {
        self.shared.read_only()
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::time::timeout;

    use super::*;
    use crate::models::{PromptKind, PromptQuestion};

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
                    resume_native_id: None,
                    options: serde_json::json!({ "persist": false }),
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

    /// 真实链路：Codex async 提问 → 问题卡片 → 回答 steer 回回合 → 模型确认。
    #[tokio::test]
    #[ignore = "calls the local Codex CLI"]
    async fn async_questions_roundtrip() {
        let adapter = CodexCliAdapter::new();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let cwd = std::env::temp_dir();
        let session = adapter
            .start_session(
                SessionContext {
                    session_id: "questions".into(),
                    project_path: cwd.to_string_lossy().to_string(),
                    access_mode: Some("read-only".into()),
                    resume_native_id: None,
                    options: serde_json::json!({ "persist": false }),
                },
                tx,
            )
            .await
            .expect("start");
        session
            .send_message(
                "Ask me TWO questions using the async questions mechanism: \
                 (1) 'Which framework should I use?' with options Vite, Next.js, Astro. \
                 (2) 'Any extra constraints?' with no options. \
                 Wait for my reply, then confirm my choices in one short sentence."
                    .into(),
            )
            .await
            .expect("send");

        let mut prompt: Option<(String, Vec<PromptQuestion>)> = None;
        let mut resolved: Option<String> = None;
        let mut final_text = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
        while tokio::time::Instant::now() < deadline {
            match timeout(Duration::from_secs(10), rx.recv()).await {
                Ok(Some(SessionEventBody::Prompt {
                    prompt_id,
                    prompt_kind: PromptKind::Questions,
                    questions,
                    ..
                })) => {
                    assert_eq!(questions.len(), 2, "expected two questions");
                    assert_eq!(questions[0].options.len(), 3, "expected three options");
                    assert!(questions[1].options.is_empty());
                    let mut answers = std::collections::HashMap::new();
                    answers.insert(questions[0].id.clone(), "Vite".to_string());
                    answers.insert(questions[1].id.clone(), "no extra constraints".to_string());
                    session
                        .answer_prompt(
                            &prompt_id,
                            PromptAnswer::Questions {
                                answers,
                                skipped: false,
                            },
                        )
                        .await
                        .expect("answer");
                    prompt = Some((prompt_id, questions));
                }
                Ok(Some(SessionEventBody::PromptResolved { answer, .. })) => {
                    resolved = Some(answer);
                }
                Ok(Some(SessionEventBody::AgentMessage { text, .. })) => {
                    final_text = text;
                }
                Ok(Some(SessionEventBody::StatusChanged {
                    status: SessionStatus::Completed,
                })) if prompt.is_some() => break,
                Ok(Some(SessionEventBody::StatusChanged {
                    status: SessionStatus::Failed,
                })) => panic!("turn failed, last message: {final_text}"),
                Ok(Some(SessionEventBody::Error { message })) => {
                    panic!("codex error: {message}")
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => {}
            }
        }
        let _ = session.stop().await;
        assert!(prompt.is_some(), "never received a question card");
        assert_eq!(
            resolved.as_deref(),
            Some("1. Vite\n2. no extra constraints"),
            "resolved summary"
        );
        assert!(
            final_text.to_ascii_lowercase().contains("vite"),
            "model did not acknowledge the answer, last message: {final_text}"
        );
    }

    /// 跳过一个 async 提问：回合应继续并完成，摘要为「已跳过」。
    #[tokio::test]
    #[ignore = "calls the local Codex CLI"]
    async fn async_questions_skip() {
        let adapter = CodexCliAdapter::new();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let cwd = std::env::temp_dir();
        let session = adapter
            .start_session(
                SessionContext {
                    session_id: "questions-skip".into(),
                    project_path: cwd.to_string_lossy().to_string(),
                    access_mode: Some("read-only".into()),
                    resume_native_id: None,
                    options: serde_json::json!({ "persist": false }),
                },
                tx,
            )
            .await
            .expect("start");
        session
            .send_message(
                "Ask me ONE question using the async questions mechanism: \
                 'Which color should the button be?' with options Red, Blue. \
                 If I decline to answer, just pick one yourself and confirm in one short sentence."
                    .into(),
            )
            .await
            .expect("send");

        let mut answered = false;
        let mut resolved: Option<String> = None;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
        while tokio::time::Instant::now() < deadline {
            match timeout(Duration::from_secs(10), rx.recv()).await {
                Ok(Some(SessionEventBody::Prompt {
                    prompt_id,
                    prompt_kind: PromptKind::Questions,
                    ..
                })) => {
                    session
                        .answer_prompt(
                            &prompt_id,
                            PromptAnswer::Questions {
                                answers: std::collections::HashMap::new(),
                                skipped: true,
                            },
                        )
                        .await
                        .expect("skip");
                    answered = true;
                }
                Ok(Some(SessionEventBody::PromptResolved { answer, .. })) => {
                    resolved = Some(answer);
                }
                Ok(Some(SessionEventBody::StatusChanged {
                    status: SessionStatus::Completed,
                })) if answered => break,
                Ok(Some(SessionEventBody::StatusChanged {
                    status: SessionStatus::Failed,
                })) => panic!("turn failed"),
                Ok(Some(SessionEventBody::Error { message })) => {
                    panic!("codex error: {message}")
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => {}
            }
        }
        let _ = session.stop().await;
        assert!(answered, "never received a question card");
        assert_eq!(resolved.as_deref(), Some("已跳过"), "skip summary");
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
                    resume_native_id: None,
                    options: serde_json::json!({ "persist": false }),
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
