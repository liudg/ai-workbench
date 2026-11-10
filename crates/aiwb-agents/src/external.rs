//! 会话协议还没接上的 Agent。只做本机探测和官方更新，不能新建会话。
//!
//! 设置页用 `session_linked = false` 表示未接入，不再附一长段说明。
//! 更新参数都是已安装 CLI 自己的子命令，不跑安装脚本。

use async_trait::async_trait;

use crate::install::{AliasRule, CliRelease};
use crate::{AgentAdapter, AgentError};
use aiwb_core::models::{AgentCapabilities, AgentKind};

const OPENCODE_NOTE: &str = "\
npm 包是 opencode-ai。安装方式认不出来时，opencode upgrade 可能在终端里询问，应用内更新就不会成功。";

pub struct ExternalCliAdapter {
    kind: AgentKind,
}

impl ExternalCliAdapter {
    pub fn new(kind: AgentKind) -> Self {
        Self { kind }
    }
}

pub fn release_for(kind: AgentKind) -> CliRelease {
    match kind {
        AgentKind::KimiCode => release(
            &["kimi"],
            "@moonshot-ai/kimi-code",
            &["upgrade", "-y"],
            &[],
            &[],
            "",
        ),
        AgentKind::QwenCode => {
            release(&["qwen"], "@qwen-code/qwen-code", &["update"], &[], &[], "")
        }
        AgentKind::OpenCode => release(
            &["opencode"],
            "opencode-ai",
            &["upgrade"],
            &[],
            &[],
            OPENCODE_NOTE,
        ),
        AgentKind::CodexCli | AgentKind::ClaudeCode | AgentKind::CursorAgent | AgentKind::Antigravity => {
            panic!("已接入的 Agent 不走外部桩适配器")
        }
    }
}

fn release(
    bins: &'static [&'static str],
    npm_package: &'static str,
    self_update: &'static [&'static str],
    version_args: &'static [&'static str],
    aliases: &'static [AliasRule],
    note: &'static str,
) -> CliRelease {
    CliRelease {
        bins,
        npm_package,
        self_update,
        locate: None,
        version_args,
        aliases,
        note,
    }
}

#[async_trait]
impl AgentAdapter for ExternalCliAdapter {
    fn kind(&self) -> AgentKind {
        self.kind
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::none()
    }

    fn icon_href(&self) -> Option<&'static str> {
        match self.kind {
            AgentKind::KimiCode => Some("/agent-icons/kimi-code.svg"),
            AgentKind::QwenCode => Some("/agent-icons/qwen-code.svg"),
            AgentKind::OpenCode => Some("/agent-icons/opencode.svg"),
            _ => None,
        }
    }

    fn cli_release(&self) -> Option<CliRelease> {
        Some(release_for(self.kind))
    }

    async fn detect(&self) -> Result<(), AgentError> {
        let found = self.installation(false).await;
        if found.installed {
            Ok(())
        } else {
            Err(AgentError::Runtime(format!(
                "未找到 {}。",
                self.display_name()
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn external_agents_cannot_open_sessions() {
        let adapter = ExternalCliAdapter::new(AgentKind::KimiCode);
        assert!(!adapter.session_linked());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let err = adapter
            .start_session(
                crate::SessionContext {
                    project_path: std::env::temp_dir().to_string_lossy().to_string(),
                    access_mode: None,
                    resume_native_id: None,
                    workbench_mcp: None,
                    options: serde_json::Value::Null,
                },
                tx,
            )
            .await
            .err()
            .expect("no session for an unlinked agent");
        assert!(err.to_string().contains("未接入"), "{err}");
        for kind in AgentKind::all() {
            if matches!(kind, AgentKind::CodexCli | AgentKind::ClaudeCode | AgentKind::CursorAgent | AgentKind::Antigravity) {
                continue;
            }
            assert!(
                !release_for(kind).note.contains("会话协议尚未接入"),
                "{}",
                kind.as_str()
            );
        }
    }

    #[test]
    fn updates_are_cli_subcommands() {
        for kind in AgentKind::all() {
            if matches!(kind, AgentKind::CodexCli | AgentKind::ClaudeCode | AgentKind::CursorAgent | AgentKind::Antigravity) {
                continue;
            }
            let release = release_for(kind);
            assert!(!release.bins.is_empty(), "{}", kind.as_str());
            for arg in release.self_update.iter().chain(
                release
                    .aliases
                    .iter()
                    .flat_map(|rule| rule.update_args.unwrap_or(&[]).iter()),
            ) {
                let lower = arg.to_ascii_lowercase();
                assert!(!lower.contains("http"), "{arg}");
                assert!(!lower.contains("curl"), "{arg}");
                assert!(!lower.contains("irm"), "{arg}");
                assert_ne!(*arg, "install");
            }
        }
    }
}
