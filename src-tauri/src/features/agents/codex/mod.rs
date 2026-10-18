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

mod approval;
mod catalog;
mod directory_client;
mod gap;
mod git_diff;
mod guardian;
mod history;
mod host;
mod mcp;
mod process;
mod prompts;
mod queue;
mod resume;
mod rpc;
mod sandbox;
mod state;
mod status;
mod subscription;
mod thread_status;
mod tokens;
mod turn;
mod usage;

mod session;

use session::CodexCliSession;

pub use resume::CodexDirectory;

/// app-server `initialize` 的 clientInfo.name；Codex 用它生成 `originator` 请求头和 User-Agent。
/// 与原生 Codex TUI 保持一致。
pub(crate) const CODEX_CLIENT_NAME: &str = "codex-tui";

/// app-server `initialize` 的 clientInfo.version：填即将拉起的 Codex 二进制自己的版本，和原生 TUI 一致。
///
/// Codex 拼 User-Agent 后缀用 `format!("{name}; {version}")`，再 trim、空串不加后缀
/// （app-server/src/request_processors/initialize_processor.rs:131，login/src/auth/default_client.rs:167-173）。
/// 读不到版本时发空串：UA 尾巴变成 `(codex-tui;)`，Codex 正常处理、不报错。
/// 不拿工作台自己的版本顶替，否则会冒充一个不存在的 Codex 版本。
pub(crate) fn client_info_version(cli_version: Option<&str>) -> &str {
    cli_version.unwrap_or("")
}

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
use crate::features::agents::{
    AgentAdapter, AgentError, AgentSession, DirectoryEntry, EventSink, SessionContext,
};
use crate::models::{
    strip_verbatim_prefix, AgentCapabilities, AgentKind, AgentProfile, SessionEventBody,
    SessionStatus,
};

use process::{
    apply_codex_network_env, classify_codex_stderr, cli_version, hide_console,
    remember_agent_stderr, resolve_codex_bin, trim_newline, StderrClass,
};
use sandbox::SandboxChoice;
use state::{emit, emit_status, Shared};

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

    async fn subscription_usage(&self) -> Result<crate::models::SubscriptionUsage, AgentError> {
        subscription::fetch().await
    }

    fn icon_href(&self) -> Option<&'static str> {
        Some("/agent-icons/codex.svg")
    }

    fn session_linked(&self) -> bool {
        true
    }

    fn mcp(&self) -> Option<Arc<dyn crate::features::agents::mcp::McpDriver>> {
        Some(mcp::driver())
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

    fn draft_permission_menu(&self) -> crate::models::PermissionMenu {
        sandbox::offline_permission_menu()
    }

    fn profile(&self) -> AgentProfile {
        AgentProfile {
            kind: self.kind(),
            capabilities: self.capabilities(),
            commands: catalog::slash_commands(),
            default_access: Some("full".into()),
            display_name: None,
            icon: None,
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

    async fn delete_thread(&self, native_id: &str) -> Result<(), AgentError> {
        CodexDirectory::shared()
            .delete_thread(native_id)
            .await
            .map_err(AgentError::Runtime)
    }

    async fn set_archived(&self, native_id: &str, archived: bool) -> Result<(), AgentError> {
        let directory = CodexDirectory::shared();
        let result = if archived {
            directory.archive_thread(native_id).await
        } else {
            directory.unarchive_thread(native_id).await
        };
        result.map_err(AgentError::Runtime)
    }

    fn prepare_worktree(
        &self,
        source: &std::path::Path,
    ) -> Result<crate::features::agents::PreparedWorktree, AgentError> {
        let root = crate::features::git::codex_worktree_root();
        let (base, sha) = crate::features::git::source_revision(source).map_err(AgentError::Runtime)?;
        let checkout = crate::features::git::create_codex_checkout(source, &root)
            .map_err(AgentError::Runtime)?;
        if let Err(err) = crate::features::git::record_owned_worktree(
            &checkout.cwd,
            &crate::features::git::OwnedMarker {
                root: checkout.root.clone(),
                base: base.clone(),
                sha: sha.clone(),
                branch: None,
            },
        ) {
            crate::features::git::remove_checkout(source, &checkout.root);
            return Err(AgentError::Runtime(err));
        }
        Ok(crate::features::agents::PreparedWorktree {
            cwd: checkout.cwd.to_string_lossy().to_string(),
            branch: None,
            cli_name: None,
            source: source.to_string_lossy().to_string(),
            rollback_root: checkout.root.to_string_lossy().to_string(),
            base,
            sha,
        })
    }

    async fn start_session(
        &self,
        ctx: SessionContext,
        events: EventSink,
    ) -> Result<Arc<dyn AgentSession>, AgentError> {
        let bin = resolve_codex_bin()?;
        let cli_version = cli_version(&bin).await;
        let version = cli_version.clone().unwrap_or_else(|| "未知版本".into());
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
        let _tracked = child.id().map(crate::features::git::note_start_child);
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
            service_tier: Mutex::new(None),
            skills: Mutex::new(Vec::new()),
            thread_id: Mutex::new(None),
            persist: ctx.flag("persist"),
            turn_id: Mutex::new(None),
            turn_files: Mutex::new(HashMap::new()),
            file_items: Mutex::new(HashMap::new()),
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
            follow_up_steer: AtomicBool::new(false),
            shown_users: Mutex::new(HashSet::new()),
            collaboration: Mutex::new(state::Collaboration::Default),
            plan_ready: AtomicBool::new(false),
            review_output: Mutex::new(None),
            history_cursor: Mutex::new(None),
            activity: Mutex::new(HashMap::new()),
            denials: Mutex::new(guardian::RecentDenials::default()),
            status_known: AtomicBool::new(false),
            token_info: Mutex::new(None),
            latest_plan: Mutex::new(None),
            instruction_sources: Mutex::new(Vec::new()),
            thread_effort: Mutex::new(None),
            thread_name: Mutex::new(None),
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
                    "clientInfo": {
                        "name": CODEX_CLIENT_NAME,
                        "version": client_info_version(cli_version.as_deref()),
                    },
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
        // 还没有线程（或 resume 没拿到线程状态）时没有回合在跑。
        if !shared.status_known.load(Ordering::SeqCst) {
            emit_status(&events, SessionStatus::Completed);
        }
        Ok(Arc::new(CodexCliSession { shared }))
    }
}

#[cfg(test)]
mod tests;
