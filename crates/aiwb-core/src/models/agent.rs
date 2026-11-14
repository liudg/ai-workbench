use serde::{Deserialize, Serialize};

pub type ProjectId = String;
pub type SessionId = String;

/// 官方升级命令的执行状态；不推测升级后的版本。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentUpgrade {
    pub kind: AgentKind,
    pub status: UpgradeStatus,
    pub output: String,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpgradeStatus {
    Running,
    Succeeded,
    Failed,
}

/// 一种 Agent 这次启动后探模型目录的结果。探成功才算能用。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CatalogProbe {
    pub kind: AgentKind,
    pub status: ProbeStatus,
    /// 探失败的原因。
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProbeStatus {
    Probing,
    Ready,
    Failed,
}

/// 已注册的 Agent CLI。新种类可以先只有探测和更新，会话仍走桩。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    CodexCli,
    ClaudeCode,
    CursorAgent,
    KimiCode,
    QwenCode,
    /// kebab-case 会把 `OpenCode` 编成 `open-code`，线上名字是 `opencode`。
    #[serde(rename = "opencode")]
    OpenCode,
    /// `agy` / `antigravity` / 停更的 `gemini` 共用这一项。
    Antigravity,
}

impl AgentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentKind::CodexCli => "codex-cli",
            AgentKind::ClaudeCode => "claude-code",
            AgentKind::CursorAgent => "cursor-agent",
            AgentKind::KimiCode => "kimi-code",
            AgentKind::QwenCode => "qwen-code",
            AgentKind::OpenCode => "opencode",
            AgentKind::Antigravity => "antigravity",
        }
    }

    /// 设置页和新建会话会列出的种类。
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

    pub fn display_name(&self) -> &'static str {
        match self {
            AgentKind::CodexCli => "Codex CLI",
            AgentKind::ClaudeCode => "Claude Code",
            AgentKind::CursorAgent => "Cursor Agent",
            AgentKind::KimiCode => "Kimi Code",
            AgentKind::QwenCode => "Qwen Code",
            AgentKind::OpenCode => "OpenCode",
            AgentKind::Antigravity => "Antigravity",
        }
    }
}
