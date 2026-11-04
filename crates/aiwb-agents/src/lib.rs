//! Agent 适配层：对外只暴露中立协议和注册表。
//!
//! 具体 CLI（Codex、Claude、其它外部 CLI）是本模块的私有实现。
//! 只有实现了 [`protocol::AgentSession`] 并覆盖 `start_session` 的适配器才能开会话；
//! 其余只做本机探测和官方更新，设置页显示「未接入」。
//! 提问卡、审批、模型目录等共享能力走协议 trait 和能力开关，
//! 会话管理和命令层不要解析某一种 CLI 的协议。

mod changes;
mod claude;
mod codex;
mod cursor;
mod directory;
mod external;
mod image_input;
mod install;
mod mcp;
mod protocol;

pub use protocol::{
    fold_page_annotations, submit_annotation_as_attachment, AgentAdapter, AgentError, AgentSession,
    EventSink, SessionContext, TurnDelivery, UserTurn, WorkbenchMcp,
};
pub use protocol::{default_git_scopes, is_turn_scope, turn_scope, AnnotationSink, DiffScope, DiffScopeProvider};


use std::sync::Arc;

use aiwb_core::models::{AgentInstallation, AgentKind, AgentProfile, McpSurface};

pub use mcp::McpDriver;
pub use install::UpgradeOutput;

pub use directory::{DirectoryEntry, DirectoryPage, SessionDirectory};

/// 按类型取得适配器实例。
pub fn adapter_for(kind: AgentKind) -> Arc<dyn AgentAdapter> {
    match kind {
        AgentKind::CodexCli => Arc::new(codex::CodexCliAdapter::new()),
        AgentKind::ClaudeCode => Arc::new(claude::ClaudeCodeAdapter::new()),
        AgentKind::CursorAgent => Arc::new(cursor::CursorAgentAdapter::new()),
        AgentKind::KimiCode
        | AgentKind::QwenCode
        | AgentKind::OpenCode
        | AgentKind::Antigravity => Arc::new(external::ExternalCliAdapter::new(kind)),
    }
}

/// 每种 Agent 的能力、斜杠命令、显示名和图标。不启动 CLI。
pub fn agent_profiles() -> Vec<AgentProfile> {
    AgentKind::all()
        .into_iter()
        .map(|kind| {
            let adapter = adapter_for(kind);
            let mut profile = adapter.profile();
            profile.display_name = Some(adapter.display_name().to_string());
            profile.icon = adapter.icon_href().map(str::to_string);
            profile
        })
        .collect()
}

/// 全部已注册种类。顺序跟着 `AgentKind::all`。没装上的也返回，设置页要列出它们。
/// `check_updates` 时顺带查官方最新版本，要走网络，会慢。
pub async fn list_installations(check_updates: bool) -> Vec<AgentInstallation> {
    let mut handles = Vec::new();
    for kind in AgentKind::all() {
        handles.push(tokio::spawn(async move {
            adapter_for(kind).installation(check_updates).await
        }));
    }
    let mut listed = Vec::new();
    for handle in handles {
        if let Ok(item) = handle.await {
            listed.push(item);
        }
    }
    listed
}

fn cli_present(adapter: &dyn AgentAdapter) -> bool {
    adapter
        .cli_release()
        .and_then(|release| install::locate_release(&release))
        .is_some()
}

/// 设置页的 MCP 管理面。一种 Agent 一份，没验证过的不假装不支持。
pub fn mcp_surfaces() -> Vec<McpSurface> {
    AgentKind::all()
        .into_iter()
        .map(|kind| {
            let adapter = adapter_for(kind);
            let installed = cli_present(adapter.as_ref());
            match adapter.mcp() {
                Some(driver) => driver.surface(installed),
                None => mcp::unverified(kind, adapter.display_name(), installed),
            }
        })
        .collect()
}

pub fn require_mcp(kind: AgentKind) -> Result<Arc<dyn McpDriver>, String> {
    let adapter = adapter_for(kind);
    if let Some(driver) = adapter.mcp() {
        return Ok(driver);
    }
    let installed = cli_present(adapter.as_ref());
    Err(mcp::unverified(kind, adapter.display_name(), installed)
        .unavailable_reason
        .unwrap_or_else(|| "暂无法管理 MCP。".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiwb_core::models::PageAnnotation;

    #[test]
    fn mcp_drivers_follow_clis_verified_on_this_machine() {
        assert!(adapter_for(AgentKind::CodexCli).mcp().is_some());
        assert!(adapter_for(AgentKind::ClaudeCode).mcp().is_some());
        assert!(adapter_for(AgentKind::CursorAgent).mcp().is_some());
        for kind in [
            AgentKind::KimiCode,
            AgentKind::QwenCode,
            AgentKind::OpenCode,
            AgentKind::Antigravity,
        ] {
            assert!(adapter_for(kind).mcp().is_none(), "{}", kind.as_str());
        }
        let surfaces = mcp_surfaces();
        assert_eq!(surfaces.len(), AgentKind::all().len());
        let kimi = surfaces
            .iter()
            .find(|item| item.kind == AgentKind::KimiCode)
            .unwrap();
        assert!(!kimi.manageable);
        let expected = if kimi.installed {
            "已检测到 Kimi Code，暂无法在此管理 MCP。"
        } else {
            "未检测到 Kimi Code，安装后可在此管理 MCP。"
        };
        let reason = kimi.unavailable_reason.as_deref().unwrap();
        assert_eq!(reason, expected);
        assert!(
            !reason.contains("未验证") && !reason.contains("未观察") && !reason.contains("动词")
        );
    }

    #[test]
    fn folds_page_annotation_into_any_agent_turn() {
        let notes = vec![PageAnnotation {
            id: "1".into(),
            url: "https://example.com/bike".into(),
            selector: "#bike".into(),
            text: "虎豹".into(),
            comment: "改成红色".into(),
            x: 10,
            y: 20,
            width: 30,
            height: 40,
            kind: "element".into(),
            screenshot: Some("C:/shot.png".into()),
            snapshot_failed: false,
        }];
        let mut images = Vec::new();
        let text = fold_page_annotations("看这里", &mut images, &notes);
        assert!(text.starts_with("看这里\n\n页面批注 1\n"));
        assert!(text.contains("评论：改成红色"));
        assert!(text.contains("页面：https://example.com/bike"));
        assert!(text.contains("选择器：#bike"));
        assert!(text.contains("元素文本：虎豹"));
        assert!(text.contains("区域：10,20 30×40"));
        assert!(text.contains("附图为该区域的截图。"));
        assert_eq!(images, vec!["C:/shot.png".to_string()]);

        let region = PageAnnotation {
            id: "2".into(),
            url: String::new(),
            selector: String::new(),
            text: String::new(),
            comment: String::new(),
            x: 1,
            y: 2,
            width: 3,
            height: 4,
            kind: "region".into(),
            screenshot: None,
            snapshot_failed: true,
        };
        let mut images = Vec::new();
        let text = fold_page_annotations("", &mut images, &[region]);
        assert_eq!(text, "页面批注 1\n区域：1,2 3×4");
        assert!(images.is_empty());
    }

    #[test]
    fn linked_sessions_are_codex_claude_and_cursor() {
        for kind in AgentKind::all() {
            let linked = matches!(
                kind,
                AgentKind::CodexCli | AgentKind::ClaudeCode | AgentKind::CursorAgent
            );
            assert_eq!(
                adapter_for(kind).session_linked(),
                linked,
                "{}",
                kind.as_str()
            );
        }
    }

    #[test]
    fn claude_capabilities_follow_the_native_cli() {
        let caps = adapter_for(AgentKind::ClaudeCode).capabilities();
        assert!(caps.supports_plan);
        assert!(caps.supports_goals);
        assert!(caps.supports_resume);
        assert!(caps.supports_queue);
        assert!(caps.supports_cancel);
        assert!(caps.supports_fork);
        assert!(!caps.supports_review);
        assert!(!caps.supports_network_access);
        assert!(caps.supports_writable_roots);
        assert!(!caps.supports_permission_profiles);
        assert!(!caps.supports_approve_for_me);
        assert!(caps.changes.turn_diff);
        assert!(caps.changes.git_scopes);
        assert!(caps.supports_subscription_usage);
    }

    #[test]
    fn subscription_usage_follows_native_quota_commands() {
        for kind in AgentKind::all() {
            let on = matches!(kind, AgentKind::CodexCli | AgentKind::ClaudeCode);
            assert_eq!(
                adapter_for(kind).capabilities().supports_subscription_usage,
                on,
                "{}",
                kind.as_str()
            );
        }
    }

    #[test]
    fn codex_capabilities_follow_the_native_cli() {
        let caps = adapter_for(AgentKind::CodexCli).capabilities();
        assert!(caps.supports_subscription_usage);
        assert!(caps.supports_cancel);
        assert!(caps.supports_queue);
    }

    #[test]
    fn cancel_is_declared_separately_from_queue() {
        let codex = adapter_for(AgentKind::CodexCli).capabilities();
        let claude = adapter_for(AgentKind::ClaudeCode).capabilities();
        assert!(codex.supports_cancel && codex.supports_queue);
        assert!(claude.supports_cancel && claude.supports_queue);
        let cursor = adapter_for(AgentKind::CursorAgent).capabilities();
        assert!(cursor.supports_cancel);
        assert!(!cursor.supports_queue);
        assert!(cursor.supports_resume && cursor.supports_tuning && cursor.supports_plan);
        for kind in [
            AgentKind::KimiCode,
            AgentKind::QwenCode,
            AgentKind::OpenCode,
            AgentKind::Antigravity,
        ] {
            let caps = adapter_for(kind).capabilities();
            assert!(!caps.supports_cancel, "{}", kind.as_str());
            assert!(!caps.supports_queue, "{}", kind.as_str());
        }
    }

    #[test]
    fn sidebar_identity_stays_on_the_owning_adapter() {
        use std::path::PathBuf;

        let profiles = crate::agent_profiles();
        let profile = |kind: AgentKind| {
            profiles
                .iter()
                .find(|item| item.kind == kind)
                .unwrap_or_else(|| panic!("missing {}", kind.as_str()))
        };
        let codex = profile(AgentKind::CodexCli);
        let claude = profile(AgentKind::ClaudeCode);
        let cursor = profile(AgentKind::CursorAgent);
        assert_eq!(codex.display_name.as_deref(), Some("Codex CLI"));
        assert_eq!(claude.display_name.as_deref(), Some("Claude Code"));
        assert_eq!(cursor.display_name.as_deref(), Some("Cursor Agent"));
        assert_ne!(codex.icon, claude.icon);
        let presets = [
            AgentKind::CodexCli,
            AgentKind::ClaudeCode,
            AgentKind::CursorAgent,
            AgentKind::KimiCode,
            AgentKind::QwenCode,
            AgentKind::OpenCode,
            AgentKind::Antigravity,
        ];
        let icons: Vec<&str> = presets
            .iter()
            .map(|kind| {
                profile(*kind)
                    .icon
                    .as_deref()
                    .unwrap_or_else(|| panic!("no icon for {}", kind.as_str()))
            })
            .collect();
        let unique: std::collections::HashSet<_> = icons.iter().collect();
        assert_eq!(unique.len(), icons.len());
        assert!(cursor.icon.is_some());
        for icon in icons {
            let relative = icon.trim_start_matches('/');
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../public")
                .join(relative);
            assert!(path.is_file(), "{}", path.display());
        }
    }
}
