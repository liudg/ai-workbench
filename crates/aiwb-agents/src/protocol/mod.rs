//! 与具体 CLI 无关的会话协议。
//!
//! Codex 和 Claude Code 都实现 [`AgentSession`] / [`AgentAdapter`]，
//! 往同一条 [`aiwb_core::models::SessionEventBody`] 通道写事件。
//! 界面和会话管理只依赖这里的方法和能力开关，不比较 Agent 种类，也不解析某一种 CLI 的报文。

mod adapter;
mod context;
mod error;
pub(crate) mod plan_choice;
mod session;
mod surface;
mod turn;

pub use adapter::AgentAdapter;
pub use context::{SessionContext, WorkbenchMcp};
pub use error::AgentError;
pub use session::{submit_annotation_as_attachment, AgentSession, EventSink};
pub use surface::{
    default_git_scopes, is_turn_scope, turn_scope, AnnotationSink, DiffScope, DiffScopeProvider,
};
pub use turn::{fold_page_annotations, TurnDelivery, UserTurn};
