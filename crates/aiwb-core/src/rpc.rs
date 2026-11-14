//! WebSocket 上的消息格式。
//!
//! 客户端发 [`Request`]；daemon 回 [`Response`]，或者给已订阅的主题推 [`Push`]。
//! 订阅后先推一份当前快照，之后每次变化再推完整的新值。会话时间线例外：只推变了的事件。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 主题：项目列表。
pub const TOPIC_PROJECTS: &str = "projects";

/// 主题：任务列表，每个任务带上它的会话和状态。
pub const TOPIC_TASKS: &str = "tasks";

pub const TOPIC_AGENT_UPGRADES: &str = "agents.upgrades";

/// 主题：各 Agent 这次启动后探模型目录的结果。
pub const TOPIC_AGENT_CATALOGS: &str = "agents.catalogs";

/// 主题前缀：一个会话的时间线。订阅参数 `fromRev` 给出客户端已有的最大 rev，只补之后的。
pub const TOPIC_SESSION_PREFIX: &str = "session:";

pub fn session_topic(session_id: &str) -> String {
    format!("{TOPIC_SESSION_PREFIX}{session_id}")
}

/// 主题前缀：一个终端的输出。订阅时先给完整回滚内容（`reset`），之后只推新增的部分。
pub const TOPIC_TERMINAL_PREFIX: &str = "terminal:";

pub fn terminal_topic(terminal_id: &str) -> String {
    format!("{TOPIC_TERMINAL_PREFIX}{terminal_id}")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Push {
    pub topic: String,
    pub data: Value,
}

impl Response {
    pub fn ok(id: u64, result: Value) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: u64, message: impl Into<String>) -> Self {
        Self {
            id,
            result: None,
            error: Some(RpcError {
                message: message.into(),
            }),
        }
    }
}
