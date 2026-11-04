//! 任务和挂在任务下的 Agent 会话。任务是工作台的核心单位，聊天只是任务里的一个视图。

use serde::{Deserialize, Serialize};

use crate::attention::Attention;
use crate::models::{AgentKind, QueuedTurn, SessionEvent, SessionStatus};

/// 任务在哪里干活：项目主目录、工作台建的工作树，或者独立聊天自己的文件夹。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaskWorkspace {
    Root,
    /// 不属于项目的独立聊天，在「无项目任务文件夹」下建的目录。
    Folder { path: String },
    #[serde(rename_all = "camelCase")]
    Worktree {
        path: String,
        branch: String,
        /// 创建时源目录所在的分支。分离头指针时为空。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_ref: Option<String>,
        base_sha: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    /// 独立聊天为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub title: String,
    pub workspace: TaskWorkspace,
    /// 开出这个子任务的任务。只有一层：子任务不再有子任务。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<String>,
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 后续回合用的选项。空表示交给 Agent 自己的默认值。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<SessionAccess>,
    /// `plan` 或 `default`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collaboration_mode: Option<String>,
    /// 回合进行中再发消息：`queue` 排队，`steer` 写进当前回合。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow_up_queue_mode: Option<String>,
}

/// 权限档位和适配器声明支持的网络、额外可写目录、具名配置档。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAccess {
    /// `full` / `ask` / `read-only` 等，由适配器解释。
    pub mode: String,
    #[serde(default)]
    pub network_access: bool,
    #[serde(default)]
    pub writable_roots: Vec<String>,
    #[serde(default)]
    pub profile_id: String,
}

/// 任务里的一次 Agent 会话。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSession {
    pub id: String,
    pub task_id: String,
    pub agent: AgentKind,
    /// Agent 自己的会话 id，resume 用。Agent 还没给出时为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    pub status: SessionStatus,
    pub options: SessionOptions,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 任务列表里的一行：任务、它的会话，和现在用的会话的注意力。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEntry {
    #[serde(flatten)]
    pub task: Task,
    pub sessions: Vec<TaskSession>,
    pub attention: Attention,
    /// 开着的侧边聊天。不算任务的会话段，不进时间线。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<TaskSession>,
}

/// 存进数据库的事件。`rev` 在会话内单调递增，事件被覆盖（流式输出）时也会换新的 `rev`，
/// 客户端断线后按 `rev` 补缺，覆盖过的旧事件也能拿到最新内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredEvent {
    #[serde(flatten)]
    pub event: SessionEvent,
    pub rev: u64,
}

/// `session:<id>` 主题的推送。快照和增量用同一个形状。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFeed {
    /// 为 true 时客户端丢掉本地缓存，用这次的事件重建。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reset: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<StoredEvent>,
    /// 排队消息的完整列表。没有变化的推送不带这一项。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue: Option<Vec<QueuedTurn>>,
}

/// 开子任务要不要先问用户，由 Agent 按用户的原话声明。照 Claude Code 桌面版嵌套会话。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Initiation {
    /// 用户要求另开或放到后台：直接开。
    UserAsked,
    /// 用户让做这件事，但没说另开：出卡片，Agent 等用户选。
    Offer,
    /// Agent 自己提议的：出卡片，Agent 不等。
    OwnInitiative,
}

/// 要开的一个子任务。跟着时间线事件走，字段和事件一样用下划线。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubtaskSpec {
    pub agent: AgentKind,
    pub title: String,
    /// 子任务的第一条消息。子任务不带父任务的对话。
    pub prompt: String,
    #[serde(default)]
    pub worktree: bool,
    #[serde(default)]
    pub options: SessionOptions,
}

/// 用户在卡片上的选择。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum OfferResolution {
    /// 另开：开出了这些子任务。
    Accepted { task_ids: Vec<String> },
    /// 就在这做，或者不要了。
    Declined,
}
