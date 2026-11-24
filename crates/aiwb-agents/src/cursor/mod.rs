//! Cursor Agent 会话，走 `agent acp`（Agent Client Protocol，stdio 上的 JSON-RPC）。
//!
//! 协议和扩展方法对照本机 Cursor Agent 2026.10.22-27dcf5f 的 `3635.index.js`
//! （`src/acp/agent-session.ts`、`src/acp/interaction-handlers/*`、`src/acp/acp-storage.ts`）
//! 和 2026-10-29 的实际收发。认证留在 CLI（`agent login`），这里不碰密钥。

mod catalog;
mod dialect;
mod directory;
mod open;
mod permission;
mod process;
mod prompts;
mod retry;
mod subagents;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod subagent_tests;
#[cfg(test)]
mod live_steering_tests;
#[cfg(test)]
mod queue_tests;

pub(crate) use process::{apply_instance_env, resolve_for};

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;

use crate::acp::session::AcpSession;
use crate::install::{locate_cursor_agent, CliRelease};
use crate::instance::InstanceOverlay;
use crate::{
    AgentAdapter, AgentError, AgentSession, DirectoryPage, EventSink, SessionContext,
};
use aiwb_core::models::{cwd_key, AgentCapabilities, AgentKind, SessionEventBody};

pub struct CursorAgentAdapter {
    overlay: Arc<InstanceOverlay>,
}

impl CursorAgentAdapter {
    pub fn new() -> Self {
        Self::with_overlay(InstanceOverlay::default_for(AgentKind::CursorAgent))
    }

    pub fn with_overlay(overlay: InstanceOverlay) -> Self {
        Self {
            overlay: Arc::new(overlay),
        }
    }
}

impl Default for CursorAgentAdapter {
    fn default() -> Self {
        Self::new()
    }
}

/// 官方安装位置优先。PATH 上别的 `agent` 不能拿来更新。
pub fn release() -> CliRelease {
    CliRelease {
        bins: &["agent", "cursor-agent"],
        npm_package: "",
        self_update: &["update"],
        locate: Some(locate_cursor_agent),
        version_args: &[],
        aliases: &[],
        note: "",
    }
}

#[async_trait]
impl AgentAdapter for CursorAgentAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::CursorAgent
    }

    fn instance_id(&self) -> Option<&str> {
        Some(&self.overlay.instance_id)
    }

    fn custom_display_name(&self) -> Option<&str> {
        self.overlay.display_name.as_deref()
    }

    fn accent_color(&self) -> Option<&str> {
        self.overlay.accent_color.as_deref()
    }

    fn custom_binary_path(&self) -> Option<&Path> {
        self.overlay.binary_path.as_deref()
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::cursor()
    }

    fn icon_href(&self) -> Option<&'static str> {
        Some("/agent-icons/cursor-agent.svg")
    }

    fn monochrome_icon(&self) -> bool {
        true
    }

    fn default_access(&self) -> Option<&'static str> {
        Some("full")
    }

    fn draft_permission_menu(&self) -> aiwb_core::models::PermissionMenu {
        permission::permission_menu("full")
    }

    fn cli_release(&self) -> Option<CliRelease> {
        Some(release())
    }

    fn mcp(&self) -> Option<Arc<dyn crate::mcp::McpDriver>> {
        Some(Arc::new(crate::mcp::CursorMcp {
            overlay: Arc::clone(&self.overlay),
        }))
    }

    async fn detect(&self) -> Result<(), AgentError> {
        process::resolve_for(&self.overlay).map(|_| ())
    }

    fn session_linked(&self) -> bool {
        true
    }

    fn takes_workbench_mcp(&self) -> bool {
        true
    }

    async fn generate_text(
        &self,
        prompt: &str,
        model: Option<&str>,
        cwd: Option<&Path>,
    ) -> Result<String, AgentError> {
        crate::text_gen::cursor_generate_text(&self.overlay, prompt, model, cwd).await
    }

    async fn rewind_thread(
        &self,
        native_id: &str,
        _cwd: &str,
        _target_turn_id: Option<&str>,
        _kept_turns: usize,
        delete_old: bool,
    ) -> Result<Option<String>, AgentError> {
        // Cursor ACP 不支持原生按回合截断：按需清理旧原生会话并返回 None，下一轮自动经 ContextHandoff 注入保留的前文。
        if delete_old {
            let _ = directory::remove_for(&self.overlay, native_id);
        }
        Ok(None)
    }

    async fn start_session(
        &self,
        ctx: SessionContext,
        events: EventSink,
    ) -> Result<Arc<dyn AgentSession>, AgentError> {
        let shared = open::open_for(
            &self.overlay,
            open::Open {
                persist: ctx.flag("persist"),
                replay_history: !ctx.flag("skip_history"),
                project_path: ctx.project_path,
                access_mode: ctx.access_mode,
                resume: ctx.resume_native_id,
                workbench_mcp: ctx.workbench_mcp,
            },
            events,
        )
        .await?;
        Ok(Arc::new(AcpSession::new(shared)))
    }

    /// 每条会话只有一个 `meta.json`，整份读出来再分页。游标是下一页的起点。
    async fn import_page(
        &self,
        cwd: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<DirectoryPage, AgentError> {
        let start = match cursor {
            Some(cursor) => cursor
                .parse::<usize>()
                .map_err(|_| AgentError::Runtime(format!("无效的游标：{cursor}")))?,
            None => 0,
        };
        let key = cwd_key(cwd);
        let listed: Vec<_> = directory::list_for(&self.overlay)
            .into_iter()
            .filter(|entry| entry.cwd_key == key)
            .collect();
        let end = (start + limit).min(listed.len());
        Ok(DirectoryPage {
            next_cursor: (end < listed.len()).then(|| end.to_string()),
            entries: listed.into_iter().skip(start).take(limit).collect(),
        })
    }

    /// `session/load` 一次推完整段历史，不分页。
    async fn import_history(
        &self,
        native_id: &str,
        cwd: &str,
    ) -> Result<Vec<SessionEventBody>, AgentError> {
        let ctx = SessionContext {
            project_path: cwd.to_string(),
            access_mode: None,
            resume_native_id: Some(native_id.to_string()),
            workbench_mcp: None,
            options: serde_json::json!({ "persist": true }),
        };
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = self.start_session(ctx, tx).await?;
        let _ = handle.stop().await;
        let mut events = Vec::new();
        while let Ok(body) = rx.try_recv() {
            events.push(body);
        }
        Ok(events)
    }

    async fn delete_thread(&self, native_id: &str) -> Result<(), AgentError> {
        directory::remove_for(&self.overlay, native_id).map_err(AgentError::Runtime)
    }
}
