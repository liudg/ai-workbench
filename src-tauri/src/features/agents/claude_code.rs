//! Claude Code 适配器。目前只接了本机探测和官方更新，会话协议未接入。
//!
//! 接入会话时实现 `AgentSession`，在这里覆盖 `start_session` / `session_linked`，
//! 并在 `session_directories` 注册 Claude 自己能 resume 的那份会话目录。
//! 工作目录用 `ctx.project_path`；认证交给 CLI 自身，应用不保存密钥。

use async_trait::async_trait;

use crate::models::{AgentCapabilities, AgentKind};

use super::install::CliRelease;
use super::{AgentAdapter, AgentError};

pub struct ClaudeCodeAdapter;

impl ClaudeCodeAdapter {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl AgentAdapter for ClaudeCodeAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::ClaudeCode
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::none()
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
        let release = self.cli_release().expect("claude cli release");
        if super::install::locate_release(&release).is_some() {
            Ok(())
        } else {
            Err(AgentError::Runtime(
                "未找到 Claude Code。请先安装并确保 `claude` 在 PATH 中。".into(),
            ))
        }
    }
}
