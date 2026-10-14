//! 一个正在运行的 Claude Code 会话。方法都走 [`super::runtime::Shared`]，
//! 不在这里解析 CLI 报文。

use std::sync::Arc;

use async_trait::async_trait;

use super::catalog;
use super::images;
use super::runtime::Shared;
use super::super::protocol::{
    default_git_scopes, fold_page_annotations, submit_annotation_as_attachment, turn_scope,
    AnnotationSink, DiffScopeProvider, TurnDelivery, UserTurn,
};
use crate::features::agents::{AgentError, AgentSession};
use crate::models::{AgentCatalog, PageAnnotation, PermissionMenu, PromptAnswer, SessionEventBody};

pub struct ClaudeSession {
    shared: Arc<Shared>,
}

impl ClaudeSession {
    pub fn new(shared: Arc<Shared>) -> Self {
        Self { shared }
    }
}

impl Drop for ClaudeSession {
    fn drop(&mut self) {
        self.shared.shutdown();
    }
}

#[async_trait]
impl AgentSession for ClaudeSession {
    async fn send_message(&self, text: String) -> Result<(), AgentError> {
        self.shared.send_text(text)
    }

    async fn deliver(&self, turn: UserTurn) -> Result<TurnDelivery, AgentError> {
        let mut images = turn.images;
        let text = fold_page_annotations(&turn.text, &mut images, &turn.annotations);
        let content = images::message_content(&text, &images)?;
        self.shared.send_content(content)?;
        Ok(TurnDelivery::Started)
    }

    async fn interrupt(&self) -> Result<(), AgentError> {
        self.shared.interrupt()
    }

    async fn answer_prompt(&self, prompt_id: &str, answer: PromptAnswer) -> Result<(), AgentError> {
        self.shared.answer_prompt(prompt_id, &answer)
    }

    async fn stop(&self) -> Result<(), AgentError> {
        self.shared.shutdown();
        Ok(())
    }

    fn set_sandbox(
        &self,
        mode: &str,
        network_access: bool,
        writable_roots: &[String],
        profile_id: &str,
    ) -> Result<(), AgentError> {
        self.shared
            .set_sandbox(mode, network_access, writable_roots, profile_id)
    }

    async fn permission_menu(&self) -> Result<PermissionMenu, AgentError> {
        Ok(catalog::permission_menu())
    }

    async fn catalog(&self) -> Result<AgentCatalog, AgentError> {
        Ok(self.shared.catalog.lock().unwrap().clone())
    }

    fn set_tuning(&self, model: Option<String>, effort: Option<String>) -> Result<(), AgentError> {
        self.shared.set_tuning(model, effort)
    }

    fn native_id(&self) -> Option<String> {
        Some(self.shared.session_id.clone())
    }

    fn set_collaboration_mode(&self, mode: &str) -> Result<(), AgentError> {
        self.shared.set_collaboration_mode(mode)
    }

    async fn set_goal(&self, objective: &str) -> Result<(), AgentError> {
        let objective = objective.trim();
        if objective.is_empty() {
            return Err(AgentError::Runtime("目标不能为空".into()));
        }
        self.shared.send_text(format!("/goal {objective}"))
    }

    async fn clear_goal(&self) -> Result<(), AgentError> {
        self.shared.send_text("/goal clear".into())
    }

    async fn publish_goal(&self) -> Result<(), AgentError> {
        self.shared.publish_goal();
        Ok(())
    }

    async fn load_older_history(&self) -> Result<(Vec<SessionEventBody>, bool), AgentError> {
        Ok(self.shared.load_older())
    }
}

#[async_trait]
impl DiffScopeProvider for ClaudeSession {
    async fn diff_scopes(&self) -> Result<Vec<crate::features::agents::DiffScope>, AgentError> {
        let mut scopes = vec![turn_scope()];
        scopes.extend(default_git_scopes());
        Ok(scopes)
    }

    async fn last_turn_diff(&self) -> Result<String, AgentError> {
        self.shared.last_turn_diff()
    }
}

#[async_trait]
impl AnnotationSink for ClaudeSession {
    async fn submit_annotation(&self, note: PageAnnotation) -> Result<TurnDelivery, AgentError> {
        submit_annotation_as_attachment(self, note).await
    }
}
