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
mod directory;
mod external;
mod install;
mod protocol;
mod providers;
mod settled;

pub use protocol::{
    fold_page_annotations, submit_annotation_as_attachment, AgentAdapter, AgentError, AgentSession,
    EventSink, SessionContext, TurnDelivery, UserTurn,
};
pub use providers::{AnnotationSink, DiffScope, DiffScopeProvider};

use std::sync::Arc;

use crate::models::{AgentInstallation, AgentKind};

pub use directory::{
    cwd_key, group_projects, session_key, sessions_for_project, DirectoryEntry, SessionDirectory,
    SourcedEntry,
};

/// 按类型取得适配器实例。
pub fn adapter_for(kind: AgentKind) -> Arc<dyn AgentAdapter> {
    match kind {
        AgentKind::CodexCli => Arc::new(codex::CodexCliAdapter::new()),
        AgentKind::ClaudeCode => Arc::new(claude::ClaudeCodeAdapter::new()),
        AgentKind::CursorAgent
        | AgentKind::CopilotCli
        | AgentKind::KimiCode
        | AgentKind::QwenCode
        | AgentKind::OpenCode
        | AgentKind::Goose
        | AgentKind::Antigravity
        | AgentKind::KiroCli => Arc::new(external::ExternalCliAdapter::new(kind)),
    }
}

/// 全部已注册种类。顺序跟着 `AgentKind::all`。没装上的也返回，设置页要列出它们。
pub async fn list_installations() -> Vec<AgentInstallation> {
    let mut handles = Vec::new();
    for kind in AgentKind::all() {
        handles.push(tokio::spawn(async move {
            adapter_for(kind).installation().await
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

pub async fn upgrade(kind: AgentKind) -> Result<AgentInstallation, AgentError> {
    adapter_for(kind).upgrade().await
}

/// 已注册的会话目录。只有会话协议已接入的 Agent 才有目录。
pub fn session_directories() -> Vec<Arc<dyn SessionDirectory>> {
    vec![
        codex::CodexDirectory::shared(),
        claude::ClaudeDirectory::shared(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::PageAnnotation;

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
        assert!(text.contains("附图为该区域所在页面的截图。"));
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
    fn linked_sessions_are_codex_and_claude() {
        for kind in AgentKind::all() {
            let linked = matches!(kind, AgentKind::CodexCli | AgentKind::ClaudeCode);
            assert_eq!(
                adapter_for(kind).session_linked(),
                linked,
                "{}",
                kind.as_str()
            );
        }
        assert_eq!(session_directories().len(), 2);
    }

    #[test]
    fn claude_does_not_pretend_to_have_codex_sandbox_tiers() {
        let caps = adapter_for(AgentKind::ClaudeCode).capabilities();
        assert!(caps.supports_plan);
        assert!(caps.supports_goals);
        assert!(caps.supports_rename);
        assert!(caps.supports_resume);
        assert!(!caps.supports_queue);
        assert!(!caps.supports_fork);
        assert!(!caps.supports_delete);
        assert!(!caps.supports_review);
        assert!(!caps.supports_network_access);
        assert!(!caps.supports_writable_roots);
        assert!(!caps.supports_permission_profiles);
        assert!(!caps.supports_approve_for_me);
        assert!(caps.changes.turn_diff);
        assert!(caps.changes.git_scopes);
    }

    #[test]
    fn sidebar_identity_stays_on_the_owning_adapter() {
        use std::path::PathBuf;

        let profiles = crate::features::ipc::agents::agent_profiles();
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
                .join("../public")
                .join(relative);
            assert!(path.is_file(), "{}", path.display());
        }
    }
}
