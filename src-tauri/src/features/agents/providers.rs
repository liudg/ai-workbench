//! 适配器表面能力。会话管理只调用这些 trait，不解析某一种 CLI 的补丁或批注格式。
//!
//! - [`DiffScopeProvider`]：差异范围。默认走 `features/git`；上一轮来自适配器保存的回合 diff。
//! - [`AnnotationSink`]：提交 [`PageAnnotation`]。默认折进附件发送。
//!
//! 逐文件变更由适配器写入 `file-change` / `turn-changes`，前端直接读事件。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::models::PageAnnotation;

use super::{AgentError, AgentSession, TurnDelivery, UserTurn};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiffScope {
    pub id: String,
    pub label: String,
    /// `git` 或 `turn`。`turn` 表示适配器提供的上一轮。
    pub source: String,
}

pub fn default_git_scopes() -> Vec<DiffScope> {
    vec![
        scope("uncommitted", "未提交", "git"),
        scope("unstaged", "未暂存", "git"),
        scope("staged", "已暂存", "git"),
    ]
}

pub fn turn_scope() -> DiffScope {
    scope("turn", "上一轮", "turn")
}

fn scope(id: &str, label: &str, source: &str) -> DiffScope {
    DiffScope {
        id: id.to_string(),
        label: label.to_string(),
        source: source.to_string(),
    }
}

pub fn is_turn_scope(scope: &str) -> bool {
    scope == "turn"
}

#[async_trait]
pub trait DiffScopeProvider: Send + Sync {
    async fn diff_scopes(&self) -> Result<Vec<DiffScope>, AgentError> {
        Ok(default_git_scopes())
    }

    async fn diff_for_scope(
        &self,
        project_path: &str,
        scope_id: &str,
        ignore_whitespace: bool,
    ) -> Result<String, AgentError> {
        if is_turn_scope(scope_id) {
            return self.last_turn_diff().await;
        }
        crate::features::git::git_diff_text(
            std::path::Path::new(project_path),
            scope_id,
            ignore_whitespace,
        )
        .map_err(AgentError::Runtime)
    }

    async fn last_turn_diff(&self) -> Result<String, AgentError> {
        Err(AgentError::Runtime("这个 Agent 没有上一轮差异".into()))
    }
}

#[async_trait]
pub trait AnnotationSink: Send + Sync {
    /// 把一条页面批注交给当前 Agent。默认实现见 [`submit_annotation_as_attachment`]。
    async fn submit_annotation(&self, note: PageAnnotation) -> Result<TurnDelivery, AgentError>;
}

/// 默认批注通道：折进正文，截图作为附件，再走 `deliver`。
pub async fn submit_annotation_as_attachment(
    session: &dyn AgentSession,
    note: PageAnnotation,
) -> Result<TurnDelivery, AgentError> {
    session
        .deliver(UserTurn {
            text: String::new(),
            images: Vec::new(),
            client_id: String::new(),
            annotations: vec![note],
        })
        .await
}
