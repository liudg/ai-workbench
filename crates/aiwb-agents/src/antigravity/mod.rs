//! Antigravity CLI 会话，走 `agy acp`（Agent Client Protocol，stdio 上的 JSON-RPC）。
//!
//! 协议和扩展字段对照本机 agy 1.5.3 的实际收发（2026-11-09）和二进制里 `jetski/cli/acp` 的符号与 JSON 标记。
//! 认证留在 CLI（第一次运行 `agy` 登录），这里不碰密钥。
//!
//! `agy acp` 没有的：分叉（`handleRequest` 只有 new / load / resume / close / list / prompt /
//! cancel / set_mode / set_model / set_config_option）、临时分支对话（`/btw` 只在 TUI 里，
//! ACP 发过去是一条普通消息，会进历史）、单独停子 Agent、`Auto` 模式（`session/set_mode` 回
//! `Unknown mode: auto`）、网络开关。

mod catalog;
mod dialect;
mod directory;
mod elicitation;
mod open;
mod permission;
mod process;
mod subagents;
mod subscription;

pub(crate) use process::NO_SELF_UPDATE;

#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod regression_tests;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use async_trait::async_trait;

use crate::acp::session::AcpSession;
use crate::install::{locate_agy, AliasCheck, AliasRule, CliRelease};
use crate::{AgentAdapter, AgentError, AgentSession, DirectoryPage, EventSink, SessionContext};
use aiwb_core::models::{
    cwd_key, AgentCapabilities, AgentInstallation, AgentKind, AgentProfile, PermissionMenu, SessionEventBody,
    SubscriptionUsage,
};

/// 只找到 `gemini`（2026-06-18 停更）或 IDE 的 `antigravity` 启动器时的提示，这两个都开不了会话。
const NO_AGY: &str = "找到的不是 Antigravity CLI（agy），安装 agy 后才能新建会话。";

pub struct AntigravityAdapter;

impl AntigravityAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl Default for AntigravityAdapter {
    fn default() -> Self {
        Self::new()
    }
}

/// 安装脚本放在 `%LOCALAPPDATA%\agy\bin`，daemon 的 PATH 不一定刷新过。
pub fn release() -> CliRelease {
    CliRelease {
        bins: &["agy", "antigravity", "gemini"],
        npm_package: "",
        self_update: &["update"],
        locate: Some(locate_agy),
        version_args: &[],
        aliases: &[AliasRule {
            name: "gemini",
            check: AliasCheck::None,
            version_args: None,
            update_args: Some(&[]),
        }],
        note: "",
    }
}

/// MCP 管理命令用的 `agy`。
pub fn binary() -> Option<std::path::PathBuf> {
    process::resolve().ok()
}

#[async_trait]
impl AgentAdapter for AntigravityAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Antigravity
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::antigravity()
    }

    fn icon_href(&self) -> Option<&'static str> {
        Some("/agent-icons/antigravity.svg")
    }

    fn profile(&self) -> AgentProfile {
        AgentProfile {
            kind: self.kind(),
            capabilities: self.capabilities(),
            commands: Vec::new(),
            default_access: Some("full".into()),
            display_name: None,
            icon: None,
            monochrome_icon: false,
        }
    }

    fn draft_permission_menu(&self) -> PermissionMenu {
        permission::permission_menu("full")
    }

    fn cli_release(&self) -> Option<CliRelease> {
        Some(release())
    }

    fn mcp(&self) -> Option<Arc<dyn crate::mcp::McpDriver>> {
        Some(Arc::new(crate::mcp::AntigravityMcp))
    }

    async fn detect(&self) -> Result<(), AgentError> {
        process::resolve().map(|_| ())
    }

    fn session_linked(&self) -> bool {
        true
    }

    async fn installation(&self, check_updates: bool) -> AgentInstallation {
        let mut item = crate::install::inspect_release(self.kind(), self.display_name(), &release(), check_updates).await;
        item.session_linked = process::resolve().is_ok();
        if item.installed && !item.session_linked {
            item.detail = Some(NO_AGY.into());
        }
        item
    }

    fn takes_workbench_mcp(&self) -> bool {
        true
    }

    async fn subscription_usage(&self) -> Result<SubscriptionUsage, AgentError> {
        subscription::fetch().await
    }

    async fn start_session(
        &self,
        ctx: SessionContext,
        events: EventSink,
    ) -> Result<Arc<dyn AgentSession>, AgentError> {
        let shared = open::open(
            open::Open {
                persist: ctx.flag("persist"),
                replay_history: !ctx.flag("skip_history"),
                roots: open::roots_of(&ctx.options),
                saved_goal: ctx.options.get("saved_goal").cloned()
                    .map(serde_json::from_value).transpose()
                    .map_err(|err| AgentError::Runtime(format!("无法恢复目标：{err}")))?,
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

    /// `session/list` 不按 `cwd` 过滤，也不分页，整份取回来再切。游标是下一页的起点。
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
        let listed: Vec<_> = open::list_threads()
            .await?
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

    /// ACP 没有删除方法。
    async fn delete_thread(&self, native_id: &str) -> Result<(), AgentError> {
        directory::remove(native_id).map_err(AgentError::Runtime)
    }
}
