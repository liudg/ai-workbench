//! 领域模型：项目、会话、会话事件。
//! 与前端 `src/types.ts` 中的类型一一对应（serde 序列化即 IPC 协议）。

use serde::{Deserialize, Serialize};

pub type ProjectId = String;
pub type SessionId = String;

/// 受支持的 Agent CLI 类型（第一波：Codex CLI / Claude Code）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    CodexCli,
    ClaudeCode,
}

impl AgentKind {
    #[allow(dead_code)] // 前端目前用自己的 AGENT_LABELS；保留给后端展示场景
    pub fn display_name(&self) -> &'static str {
        match self {
            AgentKind::CodexCli => "Codex CLI",
            AgentKind::ClaudeCode => "Claude Code",
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
}

/// 项目下的一次 Agent 会话。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: SessionId,
    pub project_id: ProjectId,
    pub agent: AgentKind,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptOption {
    pub id: String,
    pub label: String,
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
    Error {
        message: String,
    },
}

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

pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
