use serde::{Deserialize, Serialize};

use super::agent::{AgentKind, ProjectId, SessionId};

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
    /// 独立聊天的工作目录。侧栏放在「聊天」里，不进项目分组。
    #[serde(default, skip_serializing_if = "is_false")]
    pub standalone: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
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
    /// 已归档的聊天不进默认侧边栏。
    #[serde(default)]
    pub archived: bool,
}
