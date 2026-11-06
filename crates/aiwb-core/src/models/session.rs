use serde::{Deserialize, Serialize};

use super::agent::{AgentKind, ProjectId, SessionId};

/// 会话运行状态。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionStatus {
    /// 已接收首条消息，正在准备 Agent。
    Starting,
    /// 尚未开始回合。
    Idle,
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
    /// 项目根目录的绝对路径。有多个源文件夹时，这一项是第一项。
    pub path: String,
    /// 源文件夹。第一项与 `path` 相同。旧数据没有这一项时，只认 `path`。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub folders: Vec<String>,
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
    /// 会话工作目录。空表示用项目目录。有值时文件树和变更都看这里。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workdir: Option<String>,
    /// 工作树自己的分支。Codex 的托管检出没有分支，这项为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    /// 创建工作树时源目录的分支。分离头指针时为空，界面改显示短提交号。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_base: Option<String>,
    /// 创建时或当前检出的提交。界面在没有分支名时取前 7 位。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_sha: Option<String>,
    /// 这份工作树是工作台创建并记录过的。用户自己的工作树和主检出始终为 false。
    #[serde(default, skip_serializing_if = "is_false")]
    pub worktree_owned: bool,
}
