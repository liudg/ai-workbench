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
mod gap;
mod host;
mod process;
mod prompts;
mod queue;
mod resume;
mod rpc;
mod sandbox;
mod state;
mod turn;
mod worktree;

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

use crate::encoding::{apply_utf8_env, decode_child_bytes};
use crate::features::agents::install::CliRelease;
use crate::features::agents::providers::{default_git_scopes, turn_scope};
use crate::features::agents::{
    submit_annotation_as_attachment, AgentAdapter, AgentError, AgentSession, AnnotationSink,
    DiffScopeProvider, DirectoryEntry, EventSink, SessionContext, TurnDelivery, UserTurn,
};
use crate::models::{
    strip_verbatim_prefix, AgentCapabilities, AgentCatalog, AgentKind, AgentProfile, PageAnnotation,
    PromptAnswer, SessionEventBody, SessionStatus, OCCUPIED_SESSION_NOTICE,
};

use process::{
    apply_codex_network_env, classify_codex_stderr, codex_version, hide_console,
    remember_agent_stderr, resolve_codex_bin, trim_newline, StderrClass,
};
use prompts::{
    async_answer_text, blocking_answer_payload, elicitation_action_label, elicitation_result,
    is_accept, questions_summary,
};
use sandbox::SandboxChoice;
use state::{emit, emit_status, Pending, Shared};

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

    async fn fork_thread(&self, native_id: &str) -> Result<DirectoryEntry, AgentError> {
        CodexDirectory::shared()
            .fork_thread(native_id)
            .await
            .map_err(AgentError::Runtime)
    }

    async fn rename_thread(&self, native_id: &str, name: &str) -> Result<(), AgentError> {
        CodexDirectory::shared()
            .rename_thread(native_id, name)
            .await
            .map_err(AgentError::Runtime)
    }

    async fn set_thread_archived(&self, native_id: &str, archived: bool) -> Result<(), AgentError> {
        CodexDirectory::shared()
            .set_archived(native_id, archived)
            .await
            .map_err(AgentError::Runtime)
    }

    async fn delete_thread(&self, native_id: &str) -> Result<(), AgentError> {
        CodexDirectory::shared()
            .delete_thread(native_id)
            .await
            .map_err(AgentError::Runtime)
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

        let initial_access = SandboxChoice::from_mode(ctx.access_mode.as_deref().unwrap_or("full"));
        let (queue_tx, mut queue_rx) = mpsc::unbounded_channel::<()>();
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
            wire: Mutex::new(sandbox::SandboxWire::default()),
            wire_ready: AtomicBool::new(false),
            model_override: Mutex::new(None),
            effort: Mutex::new(None),
            skills: Mutex::new(Vec::new()),
            thread_id: Mutex::new(None),
            persist: ctx.flag("persist"),
            turn_id: Mutex::new(None),
            turn_files: Mutex::new(HashMap::new()),
            turn_diffs: Mutex::new(HashMap::new()),
            last_turn_id: Mutex::new(None),
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
            queue_notify: queue_tx,
            queue_refresh: tokio::sync::Mutex::new(()),
            queued: Mutex::new(Vec::new()),
            queue_removed: Mutex::new(HashSet::new()),
            shown_users: Mutex::new(HashSet::new()),
            collaboration: Mutex::new(state::Collaboration::Default),
            plan_ready: AtomicBool::new(false),
            review_output: Mutex::new(None),
            history_cursor: Mutex::new(None),
            activity: Mutex::new(HashMap::new()),
        });
        {
            let refresher = Arc::clone(&shared);
            tokio::spawn(async move {
                while queue_rx.recv().await.is_some() {
                    while queue_rx.try_recv().is_ok() {}
                    refresher.refresh_queue().await;
                }
            });
        }

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

        tokio::spawn(async move {
            // 与 stdout 相同：按字节读行，GBK 日志行解码后继续，而不是静默结束读取。
            let mut lines = BufReader::new(stderr);
            let mut raw = Vec::new();
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
                if let StderrClass::Log(message) = classify_codex_stderr(&line) {
                    remember_agent_stderr(&message);
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

        if let Some(thread_id) = ctx.resume_native_id.clone().filter(|id| !id.is_empty()) {
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

    async fn deliver(&self, turn: UserTurn) -> Result<TurnDelivery, AgentError> {
        self.shared.ensure_open()?;
        if self.shared.read_only() {
            return Err(AgentError::Runtime(OCCUPIED_SESSION_NOTICE.into()));
        }
        if turn.text.trim_start().starts_with('/') && turn.images.is_empty() {
            self.shared.handle_slash(turn.text.trim()).await?;
            return Ok(TurnDelivery::Started);
        }
        if self.shared.turn_open.load(Ordering::SeqCst) {
            self.shared
                .enqueue(turn.text, turn.images, turn.client_id, turn.annotations)
                .await?;
            return Ok(TurnDelivery::Queued);
        }
        if !turn.client_id.is_empty() {
            self.shared
                .shown_users
                .lock()
                .unwrap()
                .insert(turn.client_id.clone());
        }
        self.shared
            .begin_user_turn(turn.text, turn.images, turn.client_id, turn.annotations)
            .await?;
        Ok(TurnDelivery::Started)
    }

    async fn update_queued(&self, id: &str, turn: UserTurn) -> Result<(), AgentError> {
        self.shared.ensure_open()?;
        self.shared
            .update_queued(id, turn.text, turn.images, turn.annotations)
            .await
    }

    async fn remove_queued(&self, id: &str) -> Result<(), AgentError> {
        self.shared.ensure_open()?;
        self.shared.remove_queued(id).await
    }

    async fn interrupt(&self) -> Result<(), AgentError> {
        self.shared.ensure_open()?;
        let thread_id = self
            .shared
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Runtime("Codex 线程未建立".into()))?;
        if !self
            .shared
            .write_method("turn/interrupt", json!({ "threadId": thread_id }))
        {
            return Err(AgentError::Runtime("无法向 Codex CLI 写入消息".into()));
        }
        Ok(())
    }

    #[cfg(test)]
    async fn discard_thread(&self) -> Result<(), AgentError> {
        let Some(thread_id) = self.shared.thread_id.lock().unwrap().clone() else {
            return Ok(());
        };
        let _ = self
            .shared
            .request("thread/delete", json!({ "threadId": thread_id }))
            .await;
        Ok(())
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
                    return Err(AgentError::Runtime("请选择完全访问、询问批准或只读".into()));
                };
                let mut access = self.shared.access.lock().unwrap();
                if !access.apply_preset(value) {
                    return Err(AgentError::Runtime(
                        "请选择完全访问、询问批准、替我批准或只读".into(),
                    ));
                }
                drop(access);
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
                let decision = if is_accept(value) {
                    "accept"
                } else {
                    "decline"
                };
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
            Pending::ImplementPlan => {
                self.shared
                    .accept_implement_plan(prompt_id, &answer)
                    .await?;
            }
            Pending::Elicitation { rpc_id, questions } => {
                let result = match elicitation_result(&questions, &answer) {
                    Ok(result) => result,
                    Err(err) => {
                        self.shared.pending.lock().unwrap().insert(
                            prompt_id.to_string(),
                            Pending::Elicitation { rpc_id, questions },
                        );
                        return Err(err);
                    }
                };
                let summary = match &answer {
                    PromptAnswer::Elicitation { action, .. } => elicitation_action_label(action),
                    _ => elicitation_action_label(""),
                };
                self.shared.respond(rpc_id, result);
                self.shared.resolve_prompt(prompt_id, summary);
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
                        self.shared
                            .pending
                            .lock()
                            .unwrap()
                            .insert(prompt_id.to_string(), Pending::AsyncQuestions { questions });
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
        self.set_sandbox(mode, false, &[], "")
    }

    fn set_sandbox(
        &self,
        mode: &str,
        network_access: bool,
        writable_roots: &[String],
        profile_id: &str,
    ) -> Result<(), AgentError> {
        let cwd = self.shared.cwd.clone();
        let choice = sandbox::SandboxChoice::from_parts(
            mode,
            network_access,
            writable_roots,
            profile_id,
            &cwd,
        )?;
        let wire = *self.shared.wire.lock().unwrap();
        let ready = self.shared.wire_ready.load(Ordering::SeqCst);
        sandbox::require_supported(&choice, wire, ready)?;
        *self.shared.access.lock().unwrap() = choice;
        Ok(())
    }

    async fn permission_menu(&self) -> Result<crate::models::PermissionMenu, AgentError> {
        self.shared.refresh_sandbox_features().await
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

    fn set_collaboration_mode(&self, mode: &str) -> Result<(), AgentError> {
        self.shared.set_collaboration_mode(mode)
    }

    async fn start_review(&self, target: crate::models::ReviewStart) -> Result<(), AgentError> {
        self.shared.start_review(&target).await
    }

    async fn review_targets(&self) -> Result<crate::models::ReviewTargets, AgentError> {
        Ok(gap::git_review_targets(&self.shared.cwd).await)
    }

    async fn load_older_history(&self) -> Result<(Vec<SessionEventBody>, bool), AgentError> {
        self.shared.load_older_history().await
    }
}

#[async_trait]
impl DiffScopeProvider for CodexCliSession {
    async fn diff_scopes(&self) -> Result<Vec<crate::features::agents::DiffScope>, AgentError> {
        let mut scopes = vec![turn_scope()];
        scopes.extend(default_git_scopes());
        Ok(scopes)
    }

    async fn last_turn_diff(&self) -> Result<String, AgentError> {
        let id = self.shared.last_turn_id.lock().unwrap().clone();
        let Some(id) = id else {
            return Err(AgentError::Runtime("还没有上一轮差异".into()));
        };
        self.shared
            .turn_diffs
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| AgentError::Runtime("还没有上一轮差异".into()))
    }
}

#[async_trait]
impl AnnotationSink for CodexCliSession {
    async fn submit_annotation(&self, note: PageAnnotation) -> Result<TurnDelivery, AgentError> {
        submit_annotation_as_attachment(self, note).await
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

    /// Live check in `_gap-img-queue`: localImage input, then a queued follow-up.
    #[tokio::test]
    #[ignore = "calls the local Codex CLI in _gap-img-queue"]
    async fn gap_image_turn_and_queue() {
        let cwd = r"C:\Users\admin\Desktop\temp\ai-workbench-project\_gap-img-queue";
        let image = format!(r"{cwd}\probe.png");
        assert!(std::path::Path::new(&image).is_file(), "missing {image}");
        delete_gap_threads().await;
        let adapter = CodexCliAdapter::new();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = adapter
            .start_session(
                SessionContext {
                    project_path: cwd.into(),
                    access_mode: Some("read-only".into()),
                    resume_native_id: None,
                    options: serde_json::json!({ "persist": true }),
                },
                tx,
            )
            .await
            .expect("start");
        let started = session
            .deliver(UserTurn {
                text: "Count from 1 to 400, one number per line. Do not use tools.".into(),
                images: vec![image.clone()],
                client_id: "direct-1".into(),
                annotations: Vec::new(),
            })
            .await
            .expect("image turn");
        assert_eq!(started, TurnDelivery::Started);
        tokio::time::sleep(Duration::from_millis(800)).await;
        let queued = session
            .deliver(UserTurn {
                text: "queued follow-up".into(),
                images: vec![image],
                client_id: "queued-1".into(),
                annotations: Vec::new(),
            })
            .await
            .expect("queue");
        assert_eq!(queued, TurnDelivery::Queued);

        let queued_id = wait_queue(&mut rx, |items| {
            items
                .iter()
                .find(|item| item.text == "queued follow-up")
                .map(|item| item.id.clone())
        })
        .await
        .expect("queued follow-up");
        session
            .update_queued(
                &queued_id,
                UserTurn {
                    text: "edited follow-up".into(),
                    images: Vec::new(),
                    client_id: String::new(),
                    annotations: Vec::new(),
                },
            )
            .await
            .expect("update");
        wait_queue(&mut rx, |items| {
            items
                .iter()
                .any(|item| item.id == queued_id && item.text == "edited follow-up")
                .then_some(())
        })
        .await
        .expect("updated in place");
        session.interrupt().await.expect("interrupt");
        let mut saw_user = false;
        let mut saw_completed = false;
        let mut still_queued = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
        while tokio::time::Instant::now() < deadline {
            match timeout(Duration::from_secs(1), rx.recv()).await {
                Ok(Some(SessionEventBody::UserMessage { text, .. }))
                    if text == "edited follow-up" =>
                {
                    saw_user = true;
                }
                Ok(Some(SessionEventBody::StatusChanged {
                    status: SessionStatus::Completed,
                })) => saw_completed = true,
                Ok(Some(SessionEventBody::QueueChanged { items })) => {
                    still_queued = items.iter().any(|item| item.id == queued_id);
                    if still_queued {
                        break;
                    }
                }
                Ok(Some(_)) => {}
                _ => {}
            }
        }
        assert!(
            still_queued && !saw_user,
            "interrupt must leave the queued follow-up (completed={saw_completed}, user={saw_user}, queued={still_queued})"
        );
        session.remove_queued(&queued_id).await.expect("delete");
        wait_queue(&mut rx, |items| {
            (!items.iter().any(|item| item.id == queued_id)).then_some(())
        })
        .await
        .expect("deleted");
        let _ = session.discard_thread().await;
        let _ = session.stop().await;
        delete_gap_threads().await;
    }

    async fn delete_gap_threads() {
        let directory = CodexDirectory::new();
        let Ok(threads) = directory.list_threads().await else {
            return;
        };
        for thread in threads {
            if thread.cwd.to_ascii_lowercase().contains("_gap-img-queue") {
                let _ = directory.delete_thread(&thread.native_id).await;
            }
        }
    }

    async fn wait_queue<T>(
        rx: &mut mpsc::UnboundedReceiver<SessionEventBody>,
        mut found: impl FnMut(&[crate::models::QueuedTurn]) -> Option<T>,
    ) -> Option<T> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while tokio::time::Instant::now() < deadline {
            match timeout(Duration::from_secs(2), rx.recv()).await {
                Ok(Some(SessionEventBody::QueueChanged { items })) => {
                    if let Some(value) = found(&items) {
                        return Some(value);
                    }
                }
                Ok(Some(_)) => {}
                _ => {}
            }
        }
        None
    }

    #[tokio::test]
    #[ignore = "calls the local Codex CLI in _gap-review-plan"]
    async fn review_plan_diff_in_gap_project() {
        let cwd = r"C:\Users\admin\Desktop\temp\ai-workbench-project\_gap-review-plan";
        let adapter = CodexCliAdapter::new();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = adapter
            .start_session(
                SessionContext {
                    project_path: cwd.to_string(),
                    access_mode: Some("full".into()),
                    resume_native_id: None,
                    options: serde_json::json!({ "persist": true }),
                },
                tx,
            )
            .await
            .expect("start");
        let persisted = session.native_id().unwrap_or_default();
        let mut problem = String::new();
        if let Err(err) = session
            .start_review(crate::models::ReviewStart::Uncommitted)
            .await
        {
            problem = format!("review: {err}");
        }
        let mut saw_review = false;
        let mut review_turn = String::new();
        let review_deadline = tokio::time::Instant::now() + Duration::from_secs(150);
        while problem.is_empty() && tokio::time::Instant::now() < review_deadline {
            match timeout(Duration::from_secs(10), rx.recv()).await {
                Ok(Some(SessionEventBody::TurnAnchor { turn_id, .. })) => review_turn = turn_id,
                Ok(Some(
                    SessionEventBody::ReviewFindings { .. } | SessionEventBody::TurnDiff { .. },
                )) => saw_review = true,
                Ok(Some(SessionEventBody::StatusChanged {
                    status: SessionStatus::Completed,
                })) if saw_review => break,
                Ok(Some(SessionEventBody::StatusChanged {
                    status: SessionStatus::Failed,
                })) => problem = "review failed".into(),
                Ok(Some(SessionEventBody::Error { message })) => {
                    problem = format!("codex error: {message}");
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => {}
            }
        }
        if problem.is_empty() && !saw_review {
            problem = "review did not emit findings or a turn diff".into();
        }
        if problem.is_empty() && review_turn.is_empty() {
            problem = "review did not emit a turn id".into();
        }

        if problem.is_empty() {
            if let Err(err) = session.set_collaboration_mode("plan") {
                problem = format!("plan mode: {err}");
            }
        }
        if problem.is_empty() {
            if let Err(err) = session
                .send_message("Name two steps for renaming the seed note.".into())
                .await
            {
                problem = format!("plan turn: {err}");
            }
        }
        let mut saw_plan = false;
        let mut plan_turn = String::new();
        let mut last_text = String::new();
        let plan_deadline = tokio::time::Instant::now() + Duration::from_secs(150);
        while problem.is_empty() && tokio::time::Instant::now() < plan_deadline {
            match timeout(Duration::from_secs(10), rx.recv()).await {
                Ok(Some(SessionEventBody::TurnAnchor { turn_id, .. })) => plan_turn = turn_id,
                Ok(Some(
                    body @ (SessionEventBody::PlanSteps { .. } | SessionEventBody::PlanText { .. }),
                )) => {
                    eprintln!("plan item: {body:?}");
                    saw_plan = true;
                }
                Ok(Some(SessionEventBody::AgentMessage { text, .. })) => last_text = text,
                Ok(Some(SessionEventBody::Prompt { .. })) if saw_plan => break,
                Ok(Some(SessionEventBody::StatusChanged {
                    status: SessionStatus::Completed,
                })) if saw_plan => break,
                Ok(Some(SessionEventBody::StatusChanged {
                    status: SessionStatus::Completed,
                })) => break,
                Ok(Some(SessionEventBody::StatusChanged {
                    status: SessionStatus::Failed,
                })) => problem = format!("plan failed: {last_text}"),
                Ok(Some(SessionEventBody::Error { message })) => {
                    problem = format!("codex error: {message}");
                }
                Ok(Some(other)) => eprintln!("plan event: {other:?}"),
                Ok(None) => break,
                Err(_) => {}
            }
        }
        let _ = session.stop().await;
        if !persisted.is_empty() {
            super::resume::delete_persisted_thread(&persisted)
                .await
                .expect("delete persisted gap thread");
        }
        if problem.is_empty() && !saw_plan && last_text.trim().is_empty() {
            problem = "plan turn produced neither plan items nor a reply".into();
        }
        if problem.is_empty() && plan_turn.is_empty() {
            problem = "plan turn did not emit a turn id".into();
        }
        if saw_plan {
            eprintln!("plan turn emitted structured plan items");
        } else if problem.is_empty() {
            eprintln!("plan turn finished as assistant text: {last_text}");
        }
        if !problem.is_empty() {
            panic!("{problem}");
        }
    }
}
