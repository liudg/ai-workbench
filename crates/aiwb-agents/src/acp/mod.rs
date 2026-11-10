//! Agent Client Protocol（stdio 上的 JSON-RPC）会话的共用部分：收发、时间线映射、排队和设置。
//!
//! 报文形状照 ACP（`@agentclientprotocol/sdk`）。各 Agent 的差别收在 [`Dialect`] 里，
//! 启动和握手留在各自的适配器。

pub(crate) mod config;
mod context;
mod dialect;
pub(crate) mod permission;
pub(crate) mod queue;
pub(crate) mod rpc;
pub(crate) mod runtime;
pub(crate) mod session;
pub(crate) mod updates;

pub(crate) use dialect::{Dialect, DiffTexts, PendingAnswer, ToolSubject, ToolView, UpdateRules};
