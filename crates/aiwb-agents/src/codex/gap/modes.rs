//! 计划模式和审查在已打开线程上的动作。

use serde_json::{json, Value};

use crate::AgentError;
use aiwb_core::models::{PromptKind, ReviewStart, SessionEventBody};

use super::super::state::{emit, Collaboration, Pending, Shared};
use super::{
    classify_plan_answer, collaboration_mode_value, pick_effort, plan_collaboration_mode,
    plan_implementation_options, review_protocol, PlanChoice, CLEAR_CONTEXT_ID, IMPLEMENT_ID,
    PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX, PLAN_IMPLEMENTATION_CODING_MESSAGE,
    PLAN_IMPLEMENTATION_TITLE,
};

impl Shared {
    pub(in crate::codex) fn collaboration_is_plan(&self) -> bool {
        *self.collaboration.lock().unwrap() == Collaboration::Plan
    }

    pub(in crate::codex) fn plan_marker(&self) -> Option<String> {
        self.collaboration_is_plan().then(|| "plan".to_string())
    }

    pub(in crate::codex) fn set_collaboration_mode(
        &self,
        mode: &str,
    ) -> Result<(), AgentError> {
        let next = match mode {
            "plan" => Collaboration::Plan,
            "default" => Collaboration::Default,
            _ => {
                return Err(AgentError::Runtime(format!("未知协作模式：{mode}")));
            }
        };
        *self.collaboration.lock().unwrap() = next;
        emit(
            &self.events,
            SessionEventBody::CollaborationMode {
                mode: next.as_str().to_string(),
            },
        );
        Ok(())
    }

    pub(in crate::codex) fn plan_model(&self) -> Result<String, AgentError> {
        if let Some(model) = self.model_override.lock().unwrap().clone() {
            if !model.trim().is_empty() {
                return Ok(model);
            }
        }
        let model = self.model.lock().unwrap().clone();
        if model.trim().is_empty() {
            Err(AgentError::Runtime("计划模式需要当前线程的模型。".into()))
        } else {
            Ok(model)
        }
    }

    /// 作曲栏选的强度；没选时为线程回包里的生效强度。
    pub(in crate::codex) fn effective_effort(&self) -> Option<String> {
        pick_effort(
            self.effort.lock().unwrap().clone(),
            self.thread_effort.lock().unwrap().clone(),
        )
    }

    pub(in crate::codex) fn attach_plan_mode(
        &self,
        params: &mut Value,
    ) -> Result<(), AgentError> {
        let plan = self.collaboration_is_plan();
        let model = match self.plan_model() {
            Ok(model) => model,
            Err(err) if plan => return Err(err),
            Err(_) => return Ok(()),
        };
        // collaborationMode 覆盖整轮设置，null 会让服务端退回模型默认强度。
        // 没选过时沿用线程回包的生效强度，与作曲栏显示一致。
        let effort = self.effective_effort();
        params["collaborationMode"] = if plan {
            plan_collaboration_mode(&model, effort.as_deref())
        } else {
            collaboration_mode_value("default", &model, effort.as_deref())
        };
        Ok(())
    }

    pub(in crate::codex) async fn start_review(
        &self,
        target: &ReviewStart,
    ) -> Result<(), AgentError> {
        self.ensure_open()?;
        if self.read_only() {
            return Err(AgentError::Runtime(
                aiwb_core::models::OCCUPIED_SESSION_NOTICE.into(),
            ));
        }
        if !self.pending.lock().unwrap().is_empty() {
            return Err(AgentError::PendingPrompt);
        }
        if self.turn_open.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(AgentError::Busy);
        }
        self.ensure_thread().await?;
        let thread_id = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Runtime("Codex 线程未建立".into()))?;
        let params = json!({
            "threadId": thread_id,
            "target": review_protocol(target),
            "delivery": "inline",
        });
        self.turn_open
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if !self.write_method("review/start", params) {
            self.turn_open
                .store(false, std::sync::atomic::Ordering::SeqCst);
            return Err(AgentError::Runtime("无法向 Codex CLI 写入审查".into()));
        }
        Ok(())
    }

    pub(in crate::codex) fn note_review_output(&self, id: &str, text: &str) {
        let trimmed = text.trim();
        *self.review_output.lock().unwrap() = if trimmed.is_empty() {
            None
        } else {
            let id = if id.trim().is_empty() {
                "review".to_string()
            } else {
                id.trim().to_string()
            };
            Some((id, trimmed.to_string()))
        };
    }

    /// 退出审查后的 agentMessage 与 findings 原文相同。返回审查 item id，调用方写入 `dedupe_of`。
    pub(in crate::codex) fn take_review_duplicate(
        &self,
        text: &str,
    ) -> Option<String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }
        let mut slot = self.review_output.lock().unwrap();
        match slot.as_ref() {
            Some((id, stored)) if stored == trimmed => {
                let id = id.clone();
                *slot = None;
                Some(id)
            }
            _ => None,
        }
    }

    /// `turn_runtime.rs::maybe_prompt_plan_implementation`：计划模式、本回合出现过 plan item、
    /// 没有排队的后续消息、也没有别的待答卡片时才问。
    pub(in crate::codex) fn maybe_offer_implement_plan(&self) -> bool {
        let saw_plan = self
            .plan_ready
            .swap(false, std::sync::atomic::Ordering::SeqCst);
        if !saw_plan
            || !self.collaboration_is_plan()
            || !self.queued.lock().unwrap().is_empty()
            || !self.pending.lock().unwrap().is_empty()
        {
            return false;
        }
        let plan = self.latest_plan.lock().unwrap().clone();
        let usage = self
            .token_info
            .lock()
            .unwrap()
            .and_then(|info| info.plan_usage_label());
        let prompt_id = format!(
            "implement-plan-{}",
            self.next_id
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        );
        self.pending
            .lock()
            .unwrap()
            .insert(prompt_id.clone(), Pending::ImplementPlan);
        emit(
            &self.events,
            SessionEventBody::Prompt {
                prompt_id,
                prompt_kind: PromptKind::Choice,
                question: PLAN_IMPLEMENTATION_TITLE.to_string(),
                options: plan_implementation_options(plan.as_deref(), usage.as_deref()),
                questions: Vec::new(),
                header: String::new(),
                subtitle: String::new(),
                body: String::new(),
                body_kind: String::new(),
                reason: String::new(),
            },
        );
        true
    }

    fn restore_implement_plan(&self, prompt_id: &str) {
        self.pending
            .lock()
            .unwrap()
            .insert(prompt_id.to_string(), Pending::ImplementPlan);
    }

    pub(in crate::codex) async fn accept_implement_plan(
        &self,
        prompt_id: &str,
        answer: &aiwb_core::models::PromptAnswer,
    ) -> Result<(), AgentError> {
        let aiwb_core::models::PromptAnswer::Single { value } = answer else {
            self.restore_implement_plan(prompt_id);
            return Err(AgentError::Runtime("请选择一个选项".into()));
        };
        let plan = self.latest_plan.lock().unwrap().clone();
        let choice = match classify_plan_answer(value, plan.as_deref()) {
            Ok(choice) => choice,
            Err(message) => {
                self.restore_implement_plan(prompt_id);
                return Err(AgentError::Runtime(message));
            }
        };
        match choice {
            PlanChoice::Feedback(text) => {
                self.resolve_prompt(prompt_id, text.clone());
                self.submit_user_text(text).await
            }
            PlanChoice::Selected(choice) => {
                self.resolve_prompt(prompt_id, choice.label.clone());
                match choice.id.as_str() {
                    IMPLEMENT_ID => {
                        self.set_collaboration_mode("default")?;
                        self.submit_user_text(PLAN_IMPLEMENTATION_CODING_MESSAGE.to_string())
                            .await
                    }
                    CLEAR_CONTEXT_ID => {
                        let plan = plan.unwrap_or_default();
                        emit(
                            &self.events,
                            SessionEventBody::NewThread {
                                name: None,
                                text: Some(format!(
                                    "{PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX}\n\n{plan}"
                                )),
                                worktree: false,
                            },
                        );
                        Ok(())
                    }
                    _ => Ok(()),
                }
            }
        }
    }
}
