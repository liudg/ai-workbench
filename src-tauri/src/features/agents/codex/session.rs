//! 一个已打开的 Codex 线程。进程和 RPC 在 `state` / `rpc`，这里只实现会话契约。

use std::sync::atomic::Ordering;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;

use super::gap;
use super::prompts::{
    async_replies, blocking_answer_payload, elicitation_action_label, elicitation_result,
    is_accept, questions_summary,
};
use super::sandbox;
use super::state::{self, Pending, Shared};
use crate::features::agents::providers::{default_git_scopes, turn_scope};
use crate::features::agents::{
    submit_annotation_as_attachment, AgentError, AgentSession, AnnotationSink, DiffScopeProvider,
    TurnDelivery, UserTurn,
};
use crate::models::{
    AgentCatalog, PageAnnotation, PromptAnswer, SessionEventBody, OCCUPIED_SESSION_NOTICE,
};

pub(super) struct CodexCliSession {
    pub(super) shared: Arc<Shared>,
}

#[async_trait]
impl AgentSession for CodexCliSession {
    async fn send_message(&self, text: String) -> Result<(), AgentError> {
        self.shared.ensure_open()?;
        if self.shared.read_only() {
            return Err(AgentError::Runtime(OCCUPIED_SESSION_NOTICE.into()));
        }
        if text.starts_with('/') {
            return self.shared.handle_slash(text.trim()).await;
        }
        self.shared.begin_turn(text).await
    }

    async fn deliver(&self, turn: UserTurn) -> Result<TurnDelivery, AgentError> {
        self.shared.ensure_open()?;
        if self.shared.read_only() {
            return Err(AgentError::Runtime(OCCUPIED_SESSION_NOTICE.into()));
        }
        if turn.text.trim_start().starts_with('/') && turn.images.is_empty() {
            self.shared.handle_slash(turn.text.trim()).await?;
            return Ok(TurnDelivery::Started);
        }
        if self.shared.turn_open.load(Ordering::SeqCst) {
            self.shared
                .enqueue(turn.text, turn.images, turn.client_id, turn.annotations)
                .await?;
            return Ok(TurnDelivery::Queued);
        }
        if !turn.client_id.is_empty() {
            self.shared
                .shown_users
                .lock()
                .unwrap()
                .insert(turn.client_id.clone());
        }
        self.shared
            .begin_user_turn(turn.text, turn.images, turn.client_id, turn.annotations)
            .await?;
        Ok(TurnDelivery::Started)
    }

    async fn update_queued(&self, id: &str, turn: UserTurn) -> Result<(), AgentError> {
        self.shared.ensure_open()?;
        self.shared
            .update_queued(id, turn.text, turn.images, turn.annotations)
            .await
    }

    async fn remove_queued(&self, id: &str) -> Result<(), AgentError> {
        self.shared.ensure_open()?;
        self.shared.remove_queued(id).await
    }

    async fn interrupt(&self) -> Result<(), AgentError> {
        self.shared.ensure_open()?;
        let thread_id = self
            .shared
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Runtime("Codex 线程未建立".into()))?;
        if !self
            .shared
            .write_method("turn/interrupt", json!({ "threadId": thread_id }))
        {
            return Err(AgentError::Runtime("无法向 Codex CLI 写入消息".into()));
        }
        Ok(())
    }

    #[cfg(test)]
    async fn discard_thread(&self) -> Result<(), AgentError> {
        let Some(thread_id) = self.shared.thread_id.lock().unwrap().clone() else {
            return Ok(());
        };
        let _ = self
            .shared
            .request("thread/delete", json!({ "threadId": thread_id }))
            .await;
        Ok(())
    }

    async fn answer_prompt(&self, prompt_id: &str, answer: PromptAnswer) -> Result<(), AgentError> {
        self.shared.ensure_open()?;
        let pending = self
            .shared
            .pending
            .lock()
            .unwrap()
            .remove(prompt_id)
            .ok_or_else(|| AgentError::UnknownPrompt(prompt_id.to_string()))?;
        match pending {
            Pending::Access => {
                let PromptAnswer::Single { value } = &answer else {
                    return Err(AgentError::Runtime("请选择一个权限档位".into()));
                };
                let mut access = self.shared.access.lock().unwrap();
                if !access.apply_preset(value) {
                    access.profile_id = value.trim().to_string();
                    access.mode = state::Access::Ask;
                    access.approve_for_me = false;
                }
                drop(access);
                self.shared.resolve_prompt(prompt_id, value.clone());
                self.shared.note_access();
            }
            Pending::Approval { rpc_id } => {
                let PromptAnswer::Single { value } = &answer else {
                    return Err(AgentError::Runtime("审批只接受允许或拒绝".into()));
                };
                let decision = if is_accept(value) {
                    "accept"
                } else {
                    "decline"
                };
                self.shared.respond(rpc_id, json!({ "decision": decision }));
                self.shared.resolve_prompt(prompt_id, value.clone());
            }
            Pending::UserInput { rpc_id, questions } => {
                let payload = blocking_answer_payload(&questions, &answer);
                self.shared.respond(rpc_id, payload);
                self.shared
                    .resolve_prompt(prompt_id, questions_summary(&questions, &answer));
            }
            Pending::ImplementPlan => {
                self.shared
                    .accept_implement_plan(prompt_id, &answer)
                    .await?;
            }
            Pending::Elicitation { rpc_id, questions } => {
                let result = match elicitation_result(&questions, &answer) {
                    Ok(result) => result,
                    Err(err) => {
                        self.shared.pending.lock().unwrap().insert(
                            prompt_id.to_string(),
                            Pending::Elicitation { rpc_id, questions },
                        );
                        return Err(err);
                    }
                };
                let summary = match &answer {
                    PromptAnswer::Elicitation { action, .. } => elicitation_action_label(action),
                    _ => elicitation_action_label(""),
                };
                self.shared.respond(rpc_id, result);
                self.shared.resolve_prompt(prompt_id, summary);
            }
            Pending::ApproveDenial => {
                self.shared.approve_denial(prompt_id, &answer).await?;
            }
            Pending::AsyncQuestions { questions } => {
                // 官方没有「跳过」消息：不回答就只是本地收起，回合结束时也会收起。
                if matches!(answer, PromptAnswer::Questions { skipped: true, .. }) {
                    self.shared.resolve_prompt(prompt_id, "已跳过".into());
                    return Ok(());
                }
                let replies = async_replies(&questions, &answer);
                if replies.is_empty() {
                    self.shared
                        .pending
                        .lock()
                        .unwrap()
                        .insert(prompt_id.to_string(), Pending::AsyncQuestions { questions });
                    return Err(AgentError::Runtime("先回答至少一个问题".into()));
                }
                // 只有真正送达的回答才消耗对应问题（`chatwidget/questions.rs`）。
                let mut sent = Vec::new();
                for (question_id, reply) in &replies {
                    if let Err(err) = self.shared.steer_turn(reply).await {
                        let left: Vec<_> = questions
                            .iter()
                            .filter(|q| !sent.contains(&q.id))
                            .cloned()
                            .collect();
                        self.shared.pending.lock().unwrap().insert(
                            prompt_id.to_string(),
                            Pending::AsyncQuestions { questions: left },
                        );
                        return Err(err);
                    }
                    sent.push(question_id.clone());
                }
                self.shared
                    .resolve_prompt(prompt_id, questions_summary(&questions, &answer));
            }
        }
        Ok(())
    }

    async fn stop(&self) -> Result<(), AgentError> {
        self.shared.stop();
        Ok(())
    }

    fn set_access_mode(&self, mode: &str) -> Result<(), AgentError> {
        self.set_sandbox(mode, false, &[], "")
    }

    fn set_sandbox(
        &self,
        mode: &str,
        network_access: bool,
        writable_roots: &[String],
        profile_id: &str,
    ) -> Result<(), AgentError> {
        let cwd = self.shared.cwd.clone();
        let choice = sandbox::SandboxChoice::from_parts(
            mode,
            network_access,
            writable_roots,
            profile_id,
            &cwd,
        )?;
        let wire = *self.shared.wire.lock().unwrap();
        let ready = self.shared.wire_ready.load(Ordering::SeqCst);
        sandbox::require_supported(&choice, wire, ready)?;
        *self.shared.access.lock().unwrap() = choice;
        Ok(())
    }

    async fn permission_menu(&self) -> Result<crate::models::PermissionMenu, AgentError> {
        self.shared.refresh_sandbox_features().await
    }

    async fn catalog(&self) -> Result<AgentCatalog, AgentError> {
        self.shared.catalog().await
    }

    fn set_tuning(&self, model: Option<String>, effort: Option<String>) -> Result<(), AgentError> {
        self.shared.set_tuning(model, effort);
        Ok(())
    }

    fn native_id(&self) -> Option<String> {
        self.shared.thread_id.lock().unwrap().clone()
    }

    fn read_only(&self) -> bool {
        self.shared.read_only()
    }

    fn set_collaboration_mode(&self, mode: &str) -> Result<(), AgentError> {
        self.shared.set_collaboration_mode(mode)
    }

    async fn set_goal(&self, objective: &str) -> Result<(), AgentError> {
        self.shared.set_goal_objective(objective).await
    }

    async fn clear_goal(&self) -> Result<(), AgentError> {
        self.shared.emit_goal("clear").await
    }

    async fn publish_goal(&self) -> Result<(), AgentError> {
        self.shared.publish_goal().await
    }

    async fn start_review(&self, target: crate::models::ReviewStart) -> Result<(), AgentError> {
        self.shared.start_review(&target).await
    }

    async fn review_targets(&self) -> Result<crate::models::ReviewTargets, AgentError> {
        Ok(gap::git_review_targets(&self.shared.cwd).await)
    }

    async fn load_older_history(&self) -> Result<(Vec<SessionEventBody>, bool), AgentError> {
        self.shared.load_older_history().await
    }
}

#[async_trait]
impl DiffScopeProvider for CodexCliSession {
    async fn diff_scopes(&self) -> Result<Vec<crate::features::agents::DiffScope>, AgentError> {
        let mut scopes = vec![turn_scope()];
        scopes.extend(default_git_scopes());
        Ok(scopes)
    }

    async fn last_turn_diff(&self) -> Result<String, AgentError> {
        let id = self.shared.last_turn_id.lock().unwrap().clone();
        let Some(id) = id else {
            return Err(AgentError::Runtime("还没有上一轮差异".into()));
        };
        self.shared
            .turn_diffs
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| AgentError::Runtime("还没有上一轮差异".into()))
    }
}

#[async_trait]
impl AnnotationSink for CodexCliSession {
    async fn submit_annotation(&self, note: PageAnnotation) -> Result<TurnDelivery, AgentError> {
        submit_annotation_as_attachment(self, note).await
    }
}
