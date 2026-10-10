//! 领域模型：项目、会话、会话事件。
//! 与前端 `src/types.ts` 中的类型一一对应（serde 序列化即 IPC 协议）。

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

    pub fn all() -> [AgentKind; 10] {
        [
            AgentKind::CodexCli,
            AgentKind::ClaudeCode,
            AgentKind::CursorAgent,
            AgentKind::CopilotCli,
            AgentKind::KimiCode,
            AgentKind::QwenCode,
            AgentKind::OpenCode,
            AgentKind::Goose,
            AgentKind::Antigravity,
            AgentKind::KiroCli,
        ]
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

/// 会话运行状态。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionStatus {
    /// Agent 正在处理（流式输出中）
    Running,
    /// 等待用户输入（审批 / 回答问题）
    NeedsInput,
    /// 本轮已完成，等待下一条消息
    Completed,
    /// 异常终止
    Failed,
    /// 被用户手动停止
    Stopped,
}

/// 一个受管理的本地项目。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    /// 项目根目录的绝对路径
    pub path: String,
    pub default_agent: AgentKind,
    pub created_at: i64,
    pub updated_at: i64,
    /// 保留字段。侧边栏不再把 Agent 目录合成外部项目；已保存项目始终为 false。
    #[serde(default)]
    pub external: bool,
}

/// 项目下的一次 Agent 会话。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: SessionId,
    pub project_id: ProjectId,
    pub agent: AgentKind,
    /// Agent 自己的会话 id。工作台会话 id 是 `{agent}:{native_id}`。
    pub native_id: String,
    pub title: String,
    pub status: SessionStatus,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 需要用户输入的提问类型。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PromptKind {
    /// 审批（允许 / 拒绝）
    Approval,
    /// 多选一
    Choice,
    /// 自由文本回答
    FreeText,
    /// Codex 原生问题卡片：一轮可多题，每题编号选项 + 自由文本，可跳过
    Questions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptOption {
    pub id: String,
    pub label: String,
    /// 选项的说明文字（Codex requestUserInput 的 description）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
}

/// 问题卡片中的一道题（对应 Codex requestUserInput 的单个 question，
/// 或 async 提问消息里的一条 AsyncUserInputQuestion）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptQuestion {
    /// 阻塞式提问用 Codex 的 question id；async 提问没有 id，用 q1/q2… 按序合成
    pub id: String,
    /// 题目标签（Codex header），可空
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub header: String,
    pub question: String,
    /// 回答是敏感信息（Codex isSecret），输入时掩码
    #[serde(default)]
    pub is_secret: bool,
    /// 编号展示的选项；空数组 = 纯自由文本题
    pub options: Vec<PromptOption>,
}

/// 前端对提问的回答。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PromptAnswer {
    /// 审批决定 / 单选项 id / 单行自由文本
    Single { value: String },
    /// 问题卡片：按题回答（题 id → 文本）；skipped 表示整卡跳过
    Questions {
        answers: std::collections::HashMap<String, String>,
        skipped: bool,
    },
}

/// 会话事件体（时间线中的一条）。`kind` 字段作为判别标签。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SessionEventBody {
    UserMessage {
        text: String,
    },
    AgentMessage {
        text: String,
        /// 同一条流式回复复用这个 id，会话层会覆盖已有事件而不是追加。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stream_id: Option<String>,
    },
    /// 模型思考。有 `stream_id` 时覆盖同一条，而不是追加。
    Thinking {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stream_id: Option<String>,
    },
    ToolCall {
        name: String,
        summary: String,
    },
    /// Agent 发起的提问；在被 PromptResolved 覆盖前，会话处于 needs-input
    Prompt {
        prompt_id: String,
        prompt_kind: PromptKind,
        question: String,
        options: Vec<PromptOption>,
        /// prompt_kind == Questions 时的逐题内容；其它类型为空
        #[serde(default)]
        questions: Vec<PromptQuestion>,
    },
    PromptResolved {
        prompt_id: String,
        answer: String,
    },
    StatusChanged {
        status: SessionStatus,
    },
    System {
        text: String,
    },
    /// 线程已被另一个进程占用。历史可以看，但不能发送。
    ReadOnly {
        text: String,
    },
    Error {
        message: String,
    },
}

/// 打开已被其他进程持有写锁的 Codex 线程时，给时间线和发送拒绝用的同一句说明。
pub const OCCUPIED_SESSION_NOTICE: &str =
    "这个 Codex 会话正在被另一个进程占用，已只读打开。可以查看历史，不能在这里发送。";

/// 带序列号与时间戳的完整事件（IPC 传输与前端渲染的单位）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEvent {
    pub id: String,
    pub session_id: SessionId,
    pub seq: u64,
    pub ts: i64,
    #[serde(flatten)]
    pub body: SessionEventBody,
}

/// 去掉 Windows `\\?\` 前缀，避免界面和 Codex 工作目录显示成 `\\?\F:\...`。
pub fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    path.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReasoningEffortOption {
    pub id: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentModelOption {
    pub id: String,
    pub label: String,
    pub description: String,
    pub is_default: bool,
    pub default_effort: String,
    pub efforts: Vec<ReasoningEffortOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSkillOption {
    pub name: String,
    pub mention: String,
    pub label: String,
    pub description: String,
    pub path: String,
}

/// 适配器声明的能力。前端用它决定斜杠、技能、模型和 resume，不再比较 AgentKind 字符串。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCapabilities {
    pub supports_slash: bool,
    pub supports_resume: bool,
    pub supports_questions: bool,
    pub supports_tuning: bool,
    pub supports_skills: bool,
}

impl AgentCapabilities {
    pub fn none() -> Self {
        Self {
            supports_slash: false,
            supports_resume: false,
            supports_questions: false,
            supports_tuning: false,
            supports_skills: false,
        }
    }

    pub fn codex() -> Self {
        Self {
            supports_slash: true,
            supports_resume: true,
            supports_questions: true,
            supports_tuning: true,
            supports_skills: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashCommand {
    pub name: String,
    pub hint: String,
    #[serde(default)]
    pub takes_args: bool,
}

/// 不依赖已打开会话的静态能力说明。斜杠命令表在这里，模型/技能在会话 catalog 里。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentProfile {
    pub kind: AgentKind,
    pub capabilities: AgentCapabilities,
    pub commands: Vec<SlashCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCatalog {
    pub models: Vec<AgentModelOption>,
    pub skills: Vec<AgentSkillOption>,
    pub commands: Vec<SlashCommand>,
    pub capabilities: AgentCapabilities,
}

impl AgentCatalog {
    pub fn empty() -> Self {
        Self {
            models: Vec::new(),
            skills: Vec::new(),
            commands: Vec::new(),
            capabilities: AgentCapabilities::none(),
        }
    }
}

/// 官方升级走哪条已声明的渠道。前端只展示，不拼命令。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateVia {
    /// `npm install -g <package>@latest`
    Npm,
    /// 适配器声明的 CLI 自更新，例如 `claude update`。
    Cli,
}

/// 本机一次探测的结果。设置页列出全部已注册 CLI；新建会话只取 `installed`。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentInstallation {
    pub kind: AgentKind,
    pub display_name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub update_via: Option<UpdateVia>,
    pub detail: Option<String>,
}

impl AgentInstallation {
    pub fn absent(kind: AgentKind, display_name: &str) -> Self {
        Self {
            kind,
            display_name: display_name.to_string(),
            installed: false,
            version: None,
            latest_version: None,
            update_available: false,
            update_via: None,
            detail: None,
        }
    }
}

pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
