use serde::{Deserialize, Serialize};

pub type ProjectId = String;
pub type SessionId = String;

/// 已注册的 Agent CLI。新种类可以先只有探测和更新，会话仍走桩。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    CodexCli,
    ClaudeCode,
    CursorAgent,
    CopilotCli,
    KimiCode,
    QwenCode,
    /// kebab-case 会把 `OpenCode` 编成 `open-code`，线上名字是 `opencode`。
    #[serde(rename = "opencode")]
    OpenCode,
    Goose,
    /// `agy` / `antigravity` / 停更的 `gemini` 共用这一项。
    Antigravity,
    /// `kiro-cli` 与兼容入口 `q` 共用这一项。
    KiroCli,
}

impl AgentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentKind::CodexCli => "codex-cli",
            AgentKind::ClaudeCode => "claude-code",
            AgentKind::CursorAgent => "cursor-agent",
            AgentKind::CopilotCli => "copilot-cli",
            AgentKind::KimiCode => "kimi-code",
            AgentKind::QwenCode => "qwen-code",
            AgentKind::OpenCode => "opencode",
            AgentKind::Goose => "goose",
            AgentKind::Antigravity => "antigravity",
            AgentKind::KiroCli => "kiro-cli",
        }
    }

    /// 设置页和新建会话会列出的种类。Goose、GitHub Copilot CLI、Kiro CLI 不参与探测。
    pub fn all() -> [AgentKind; 7] {
        [
            AgentKind::CodexCli,
            AgentKind::ClaudeCode,
            AgentKind::CursorAgent,
            AgentKind::KimiCode,
            AgentKind::QwenCode,
            AgentKind::OpenCode,
            AgentKind::Antigravity,
        ]
    }

    #[cfg(test)]
    pub fn hidden(self) -> bool {
        matches!(
            self,
            AgentKind::CopilotCli | AgentKind::Goose | AgentKind::KiroCli
        )
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            AgentKind::CodexCli => "Codex CLI",
            AgentKind::ClaudeCode => "Claude Code",
            AgentKind::CursorAgent => "Cursor Agent",
            AgentKind::CopilotCli => "GitHub Copilot CLI",
            AgentKind::KimiCode => "Kimi Code",
            AgentKind::QwenCode => "Qwen Code",
            AgentKind::OpenCode => "OpenCode",
            AgentKind::Goose => "Goose",
            AgentKind::Antigravity => "Antigravity",
            AgentKind::KiroCli => "Kiro CLI",
        }
    }
}
