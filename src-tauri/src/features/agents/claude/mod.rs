//! Claude Code 会话。
//!
//! 启动参数和 stdin 控制帧对齐官方 Python SDK
//! `claude_agent_sdk/_internal/transport/subprocess_cli.py`、`query.py`，
//! 以及 CLI 源码里 headless 必须带的 `--print` / `--verbose`
//! （`main.tsx` 非交互判断、`cli/print.ts` 的 stream-json 要求）
//! 和 `--allow-dangerously-skip-permissions`
//! （`utils/permissions/permissionSetup.ts` `initializeToolPermissionContext`）。
//! 认证留在 CLI。这里不保存密钥，也不传 `--system-prompt ""`。

mod catalog;
mod command;
mod control;
mod diff;
mod directory;
mod history;
mod images;
mod messages;
mod mutate;
mod permission;
mod process;
mod runtime;
mod session;
mod usage;

#[cfg(test)]
mod tests;

pub use directory::ClaudeDirectory;

use std::sync::Arc;

use async_trait::async_trait;

use session::ClaudeSession;

use crate::features::agents::install::CliRelease;
use crate::features::agents::{AgentAdapter, AgentError, AgentSession, EventSink, SessionContext};
use crate::models::{AgentCapabilities, AgentKind, AgentProfile};

pub struct ClaudeCodeAdapter;

impl ClaudeCodeAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ClaudeCodeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentAdapter for ClaudeCodeAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::ClaudeCode
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::claude()
    }

    fn icon_href(&self) -> Option<&'static str> {
        Some("/agent-icons/claude.svg")
    }

    fn profile(&self) -> AgentProfile {
        AgentProfile {
            kind: self.kind(),
            capabilities: self.capabilities(),
            commands: Vec::new(),
            default_access: Some("full".into()),
            display_name: None,
            icon: None,
        }
    }

    fn session_linked(&self) -> bool {
        true
    }

    fn cli_release(&self) -> Option<CliRelease> {
        Some(CliRelease {
            bins: &["claude"],
            npm_package: "@anthropic-ai/claude-code",
            self_update: &["update"],
            locate: None,
            version_args: &[],
            aliases: &[],
            note: "",
        })
    }

    async fn detect(&self) -> Result<(), AgentError> {
        process::resolve_claude_bin().map(|_| ())
    }

    async fn start_session(
        &self,
        ctx: SessionContext,
        events: EventSink,
    ) -> Result<Arc<dyn AgentSession>, AgentError> {
        let shared = runtime::open(
            ctx.project_path,
            ctx.access_mode,
            ctx.resume_native_id,
            events,
        )
        .await?;
        Ok(Arc::new(ClaudeSession::new(shared)))
    }

    async fn rename_thread(&self, native_id: &str, name: &str) -> Result<(), AgentError> {
        if !history::is_uuid(native_id) {
            return Err(AgentError::Runtime(format!("无效的会话 id：{native_id}")));
        }
        let title = name.trim();
        if title.is_empty() {
            return Err(AgentError::Runtime("标题不能为空".into()));
        }
        let file = history::find_session_file(native_id);
        let live = runtime::live_session(native_id);
        if file.is_some() {
            mutate::append_custom_title(native_id, title).map_err(AgentError::Runtime)?;
            if let Some(shared) = live {
                let _ = shared.fire_rename(title);
            }
            return Ok(());
        }
        if let Some(shared) = live {
            return shared.fire_rename(title);
        }
        Err(AgentError::Runtime(format!("找不到会话 {native_id}")))
    }
}
