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
mod history;
mod images;
mod mcp;
mod messages;
mod permission;
mod process;
mod queue;
mod runtime;
mod session;
mod subagents;
mod subscription;
mod usage;

#[cfg(test)]
mod subagent_tests;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use async_trait::async_trait;

use session::ClaudeSession;

use crate::install::CliRelease;
use crate::{
    AgentAdapter, AgentError, AgentSession, DirectoryEntry, DirectoryPage, EventSink,
    SessionContext,
};
use aiwb_core::models::{cwd_key, AgentCapabilities, AgentKind, AgentProfile, SessionStatus};

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

    async fn subscription_usage(&self) -> Result<aiwb_core::models::SubscriptionUsage, AgentError> {
        subscription::fetch().await
    }

    fn icon_href(&self) -> Option<&'static str> {
        Some("/agent-icons/claude.svg")
    }

    fn draft_permission_menu(&self) -> aiwb_core::models::PermissionMenu {
        let active = self
            .profile()
            .default_access
            .filter(|mode| !mode.is_empty())
            .unwrap_or_else(|| "full".into());
        permission::permission_menu(&active)
    }

    /// 只读 `~/.claude/projects` 下这个项目的目录，不起 CLI。
    async fn import_page(
        &self,
        cwd: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<DirectoryPage, AgentError> {
        let page =
            history::list_project_page(cwd, cursor, limit).map_err(AgentError::Runtime)?;
        Ok(DirectoryPage {
            entries: page.sessions.into_iter().map(listed_entry).collect(),
            next_cursor: page.next_cursor,
        })
    }

    /// 直接读 `~/.claude/projects` 里的转录，不起 CLI。
    async fn import_history(
        &self,
        native_id: &str,
        cwd: &str,
    ) -> Result<Vec<aiwb_core::models::SessionEventBody>, AgentError> {
        if !history::is_uuid(native_id) {
            return Err(AgentError::Runtime(format!("无效的会话 id：{native_id}")));
        }
        let path = history::find_session_file(native_id)
            .ok_or_else(|| AgentError::Runtime(format!("找不到会话 {native_id}")))?;
        let text = history::read_session_text(&path)
            .ok_or_else(|| AgentError::Runtime(format!("读不了会话 {native_id}")))?;
        let mut state = messages::MapState::default();
        state.subagent_dir = Some(history::subagent_dir(&path));
        let mut events =
            messages::events_from_transcript(&mut state, &text, Some(std::path::Path::new(cwd)));
        events.extend(usage::snapshot_from_transcript(&text));
        Ok(events)
    }

    async fn discard_unsent_thread(&self, native_id: &str) -> Result<(), AgentError> {
        history::remove_session_file(native_id).map_err(AgentError::Runtime)
    }

    /// `--fork-session` 不带提示词会失败（CLI：`No deferred tool marker found... Provide a prompt`）。
    /// 带一条占位提示会多出用户没写的回合。分叉就是把转录复制成新的 session id。
    async fn fork_thread(&self, native_id: &str, cwd: Option<&str>) -> Result<DirectoryEntry, AgentError> {
        history::fork_session_file(native_id, cwd)
            .map(listed_entry)
            .map_err(AgentError::Runtime)
    }

    /// 没有按会话删除的子命令。`purge` 删整个项目，`rm` 删后台会话。
    /// 删掉 `<uuid>.jsonl` 之后再 `--resume` 会得到 `No conversation found with session ID`。
    async fn delete_thread(&self, native_id: &str) -> Result<(), AgentError> {
        if !history::is_uuid(native_id) {
            return Err(AgentError::Runtime(format!("无效的会话 id：{native_id}")));
        }
        if history::find_session_file(native_id).is_none() {
            return Err(AgentError::Runtime(format!("找不到会话 {native_id}")));
        }
        history::remove_session_file(native_id).map_err(AgentError::Runtime)
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

    fn takes_workbench_mcp(&self) -> bool {
        true
    }

    fn mcp(&self) -> Option<Arc<dyn crate::mcp::McpDriver>> {
        Some(mcp::driver())
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
        let replay_history = !ctx.flag("skip_history");
        let has_history = ctx.flag("has_history");
        let side_of = ctx.side_of();
        let shared = runtime::open(
            ctx.project_path,
            ctx.access_mode,
            ctx.resume_native_id,
            side_of,
            command::roots_from_options(&ctx.options),
            replay_history,
            has_history,
            ctx.workbench_mcp,
            events,
        )
        .await?;
        Ok(Arc::new(ClaudeSession::new(shared)))
    }

}

fn listed_entry(listed: history::ListedSession) -> DirectoryEntry {
    DirectoryEntry {
        native_id: listed.session_id,
        cwd_key: cwd_key(&listed.cwd),
        cwd: listed.cwd,
        title: listed.title,
        created_at: listed.created_at,
        updated_at: listed.updated_at,
        status: SessionStatus::Completed,
        ephemeral: false,
        archived: false,
    }
}
