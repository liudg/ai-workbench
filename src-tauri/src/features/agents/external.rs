//! 协议还没接上的 Agent。只做本机探测和官方更新，会话仍是桩。
//!
//! 设置页用 `session_linked = false` 表示未接入，不再附一长段说明。
//! 更新参数都是已安装 CLI 自己的子命令，不跑安装脚本。

use std::sync::Arc;

use async_trait::async_trait;

use crate::features::agents::directory::{DirectoryEntry, SessionDirectory};
use crate::features::agents::install::{AliasCheck, AliasRule, CliRelease};
use crate::features::agents::stub::{StubAgentSession, StubPersona};
use crate::features::agents::{AgentAdapter, AgentError, AgentSession, EventSink, SessionContext};
use crate::models::{AgentCapabilities, AgentInstallation, AgentKind, ChangeCapabilities};

const GEMINI_NOTE: &str = "\
Gemini CLI（gemini）已于 2026-06-18 停更，官方后继是 Antigravity CLI。\
优先识别 agy，其次 antigravity，最后才是仍留在 PATH 上的 gemini。\
只找到 gemini 时不在应用内更新。";

const KIRO_NOTE: &str = "\
Kiro CLI 是 Amazon Q Developer CLI 的后继。官方入口是 kiro-cli，q 仍是兼容入口。\
无关的 q 只有在版本输出里出现 Kiro 或 Amazon Q，或首行是 q 1.2.3 这种官方短版本时才算已安装。\
更新用 kiro-cli update --non-interactive；只找到旧的 q 时用 q update。";

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
        AgentKind::CursorAgent => {
            let mut item = release(&["agent", "cursor-agent"], "", &["update"], &[], &[], "");
            item.locate = Some(super::install::locate_cursor_agent);
            item
        }
        AgentKind::CopilotCli => release(
            &["copilot"],
            "@github/copilot",
            &["update"],
            &["version"],
            &[],
            "",
        ),
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
        AgentKind::Goose => release(&["goose"], "", &["update"], &[], &[], ""),
        AgentKind::Antigravity => release(
            &["agy", "antigravity", "gemini"],
            "",
            &["update"],
            &[],
            &[AliasRule {
                name: "gemini",
                check: AliasCheck::None,
                version_args: None,
                update_args: Some(&[]),
            }],
            GEMINI_NOTE,
        ),
        AgentKind::KiroCli => release(
            &["kiro-cli", "q"],
            "",
            &["update", "--non-interactive"],
            &["version"],
            &[AliasRule {
                name: "q",
                check: AliasCheck::AmazonQ,
                version_args: None,
                update_args: Some(&["update"]),
            }],
            KIRO_NOTE,
        ),
        AgentKind::CodexCli | AgentKind::ClaudeCode => {
            panic!("Codex 和 Claude 不走外部桩适配器")
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

fn unlink(mut item: AgentInstallation) -> AgentInstallation {
    item.session_linked = false;
    item
}

pub struct EmptyDirectory {
    kind: AgentKind,
}

impl EmptyDirectory {
    pub fn new(kind: AgentKind) -> Self {
        Self { kind }
    }
}

#[async_trait]
impl SessionDirectory for EmptyDirectory {
    fn kind(&self) -> AgentKind {
        self.kind
    }

    async fn list(&self) -> Result<Vec<DirectoryEntry>, String> {
        Ok(Vec::new())
    }

    async fn invalidate(&self) {}
}

#[async_trait]
impl AgentAdapter for ExternalCliAdapter {
    fn kind(&self) -> AgentKind {
        self.kind
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities {
            supports_slash: false,
            supports_resume: false,
            supports_questions: true,
            supports_tuning: false,
            supports_skills: false,
            supports_goals: false,
            supports_images: false,
            supports_queue: false,
            supports_fork: false,
            supports_delete: false,
            supports_rename: false,
            supports_plan: false,
            changes: ChangeCapabilities::git_only(),
            supports_review: false,
            supports_network_access: false,
            supports_writable_roots: false,
            supports_permission_profiles: false,
            supports_approve_for_me: false,
            supports_paged_history: false,
        }
    }

    fn cli_release(&self) -> Option<CliRelease> {
        Some(release_for(self.kind))
    }

    async fn upgrade(&self) -> Result<AgentInstallation, AgentError> {
        let Some(release) = self.cli_release() else {
            return Err(AgentError::Runtime(format!(
                "{} 没有官方更新入口",
                self.display_name()
            )));
        };
        super::install::upgrade_release(self.kind, self.display_name(), &release)
            .await
            .map(unlink)
            .map_err(AgentError::Runtime)
    }

    async fn detect(&self) -> Result<(), AgentError> {
        let found = self.installation().await;
        if found.installed {
            Ok(())
        } else {
            Err(AgentError::Runtime(format!(
                "未找到 {}。",
                self.display_name()
            )))
        }
    }

    async fn installation(&self) -> AgentInstallation {
        let release = release_for(self.kind);
        let found = super::install::inspect_release(self.kind, self.display_name(), &release).await;
        unlink(found)
    }

    async fn start_session(
        &self,
        _ctx: SessionContext,
        events: EventSink,
    ) -> Result<Arc<dyn AgentSession>, AgentError> {
        let session = StubAgentSession::new(
            StubPersona {
                cli_label: self.kind.display_name(),
            },
            events.clone(),
            self.capabilities(),
        );
        let _ = events.send(crate::models::SessionEventBody::StatusChanged {
            status: crate::models::SessionStatus::Completed,
        });
        Ok(Arc::new(session))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn live_cursor_update_runs_agent_update() {
        let adapter = ExternalCliAdapter::new(AgentKind::CursorAgent);
        let before = adapter.installation().await;
        assert!(before.installed, "{:?}", before);
        let after = adapter.upgrade().await.expect("agent update");
        eprintln!(
            "cursor update before={:?} after={:?} available={} detail={:?}",
            before.version, after.version, after.update_available, after.detail
        );
        assert!(after.installed);
        assert!(!after.update_available, "{:?}", after.detail);
    }

    #[test]
    fn cursor_update_is_the_official_subcommand() {
        let release = release_for(AgentKind::CursorAgent);
        assert_eq!(release.bins, ["agent", "cursor-agent"].as_slice());
        assert_eq!(release.self_update, ["update"].as_slice());
        assert!(release.npm_package.is_empty());
        assert!(release.locate.is_some());
        let found = (release.locate.unwrap())();
        if let Some(path) = found {
            assert!(path.ends_with("agent.cmd"));
        }
    }

    #[test]
    fn external_cards_are_not_session_linked() {
        let item = unlink(AgentInstallation::absent(AgentKind::KimiCode, "Kimi Code"));
        assert!(!item.session_linked);
        assert!(item.detail.as_deref().unwrap_or("").is_empty());
        for kind in AgentKind::all() {
            if matches!(kind, AgentKind::CodexCli | AgentKind::ClaudeCode) {
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
            if matches!(kind, AgentKind::CodexCli | AgentKind::ClaudeCode) {
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
