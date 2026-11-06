//! 一个正在运行的 Cursor Agent 会话。方法都走 [`super::runtime::Shared`]。

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::super::protocol::{
    default_git_scopes, submit_annotation_as_attachment, turn_scope,
    AnnotationSink, DiffScopeProvider, TurnDelivery, UserTurn,
};
use super::permission;
use super::runtime::Shared;
use super::queue::Input;
use crate::image_input;
use crate::{AgentError, AgentSession};
use aiwb_core::models::{AgentCatalog, PageAnnotation, PermissionMenu, PromptAnswer};

pub struct CursorSession {
    shared: Arc<Shared>,
}

impl CursorSession {
    pub fn new(shared: Arc<Shared>) -> Self {
        Self { shared }
    }
}

impl Drop for CursorSession {
    fn drop(&mut self) {
        self.shared.shutdown();
    }
}

/// ACP `ContentBlock`：文字块加 `image` 块（`promptCapabilities.image = true`）。
pub fn prompt_blocks(text: &str, images: &[String]) -> Result<Vec<Value>, AgentError> {
    let mut blocks = Vec::new();
    if !text.trim().is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    for image in images {
        let (mime, data) = image_input::load(image)?;
        blocks.push(json!({ "type": "image", "mimeType": mime, "data": data }));
    }
    if blocks.is_empty() {
        return Err(AgentError::Runtime("消息不能为空".into()));
    }
    Ok(blocks)
}

#[async_trait]
impl AgentSession for CursorSession {
    async fn send_message(&self, text: String) -> Result<(), AgentError> {
        self.deliver(UserTurn { text, images: Vec::new(), client_id: String::new(), annotations: Vec::new() }).await.map(|_| ())
    }

    async fn deliver(&self, turn: UserTurn) -> Result<TurnDelivery, AgentError> {
        self.shared.submit(Input::new(turn)?, false)
    }

    async fn deliver_now(&self, turn: UserTurn) -> Result<TurnDelivery, AgentError> {
        self.shared.submit(Input::new(turn)?, true)
    }

    async fn update_queued(&self, id: &str, turn: UserTurn) -> Result<(), AgentError> {
        self.shared.update_queued(id, Input::new(turn)?)
    }

    async fn remove_queued(&self, id: &str) -> Result<(), AgentError> {
        self.shared.remove_queued(id)
    }

    async fn steer_queued(&self, id: &str) -> Result<(), AgentError> {
        self.shared.flush_queued(vec![id.to_string()])
    }

    async fn flush_queued(&self, ids: Vec<String>) -> Result<(), AgentError> {
        self.shared.flush_queued(ids)
    }

    async fn set_follow_up_queue_mode(&self, mode: &str) -> Result<(), AgentError> {
        self.shared.set_follow_up_queue_mode(mode)
    }

    async fn interrupt(&self) -> Result<(), AgentError> {
        self.shared.interrupt()
    }

    async fn answer_prompt(&self, prompt_id: &str, answer: PromptAnswer) -> Result<(), AgentError> {
        self.shared.answer_prompt(prompt_id, &answer)
    }

    async fn stop(&self) -> Result<(), AgentError> {
        self.shared.shutdown_and_wait().await;
        Ok(())
    }

    fn set_access_mode(&self, mode: &str) -> Result<(), AgentError> {
        self.shared.set_access(mode);
        Ok(())
    }

    fn set_sandbox(
        &self,
        mode: &str,
        network_access: bool,
        writable_roots: &[String],
        profile_id: &str,
    ) -> Result<(), AgentError> {
        if network_access {
            return Err(AgentError::Runtime("不支持网络访问开关".into()));
        }
        if !writable_roots.is_empty() {
            return Err(AgentError::Runtime("不支持额外目录".into()));
        }
        if !profile_id.trim().is_empty() {
            return Err(AgentError::Runtime("不支持具名权限配置档".into()));
        }
        self.shared.set_access(mode);
        Ok(())
    }

    async fn permission_menu(&self) -> Result<PermissionMenu, AgentError> {
        Ok(permission::permission_menu(&self.shared.current_access()))
    }

    async fn catalog(&self) -> Result<AgentCatalog, AgentError> {
        Ok(self.shared.catalog.lock().unwrap().clone())
    }

    fn set_tuning(&self, model: Option<String>, effort: Option<String>) -> Result<(), AgentError> {
        self.shared.set_tuning(model, effort);
        Ok(())
    }

    fn set_service_tier(&self, tier: Option<String>) -> Result<(), AgentError> {
        self.shared.set_fast(tier);
        Ok(())
    }

    fn native_id(&self) -> Option<String> {
        self.shared.session_id()
    }

    fn set_collaboration_mode(&self, mode: &str) -> Result<(), AgentError> {
        match mode {
            "plan" => self.shared.set_plan(true),
            "default" => self.shared.set_plan(false),
            _ => return Err(AgentError::Runtime(format!("不认识的协作模式 {mode}"))),
        }
        Ok(())
    }
}

#[async_trait]
impl DiffScopeProvider for CursorSession {
    async fn diff_scopes(&self) -> Result<Vec<crate::DiffScope>, AgentError> {
        let mut scopes = vec![turn_scope()];
        scopes.extend(default_git_scopes());
        Ok(scopes)
    }

    async fn last_turn_diff(&self) -> Result<String, AgentError> {
        self.shared.last_turn_diff()
    }
}

#[async_trait]
impl AnnotationSink for CursorSession {
    async fn submit_annotation(&self, note: PageAnnotation) -> Result<TurnDelivery, AgentError> {
        submit_annotation_as_attachment(self, note).await
    }
}
