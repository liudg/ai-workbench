//! 计划模式和审查在已打开线程上的动作。

use serde_json::{json, Value};

use crate::features::agents::AgentError;
use crate::models::{PromptKind, ReviewStart, SessionEventBody};

use super::super::state::{emit, Collaboration, Pending, Shared};
use super::{
    collaboration_mode_value, plan_collaboration_mode, plan_implementation_options,
    review_protocol, CLEAR_CONTEXT_ID, IMPLEMENT_ID, PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX,
    PLAN_IMPLEMENTATION_CODING_MESSAGE, PLAN_IMPLEMENTATION_TITLE,
};

impl Shared {
    pub(in crate::features::agents::codex) fn collaboration_is_plan(&self) -> bool {
        *self.collaboration.lock().unwrap() == Collaboration::Plan
    }

    pub(in crate::features::agents::codex) fn plan_marker(&self) -> Option<String> {
        self.collaboration_is_plan().then(|| "plan".to_string())
    }

    pub(in crate::features::agents::codex) fn set_collaboration_mode(
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

    pub(in crate::features::agents::codex) fn plan_model(&self) -> Result<String, AgentError> {
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

    pub(in crate::features::agents::codex) fn attach_plan_mode(
        &self,
        params: &mut Value,
    ) -> Result<(), AgentError> {
        let plan = self.collaboration_is_plan();
        let model = match self.plan_model() {
            Ok(model) => model,
            Err(err) if plan => return Err(err),
            Err(_) => return Ok(()),
        };
        let effort = self.effort.lock().unwrap().clone();
        params["collaborationMode"] = if plan {
            plan_collaboration_mode(&model, effort.as_deref())
        } else {
            collaboration_mode_value("default", &model, effort.as_deref())
        };
        Ok(())
    }

    pub(in crate::features::agents::codex) async fn start_review(
        &self,
        target: &ReviewStart,
    ) -> Result<(), AgentError> {
        self.ensure_open()?;
        if self.read_only() {
            return Err(AgentError::Runtime(
                crate::models::OCCUPIED_SESSION_NOTICE.into(),
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

    pub(in crate::features::agents::codex) fn note_review_output(&self, id: &str, text: &str) {
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
    pub(in crate::features::agents::codex) fn take_review_duplicate(
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
    pub(in crate::features::agents::codex) fn maybe_offer_implement_plan(&self) -> bool {
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
            },
        );
        true
    }

    pub(in crate::features::agents::codex) async fn accept_implement_plan(
        &self,
        prompt_id: &str,
        answer: &crate::models::PromptAnswer,
    ) -> Result<(), AgentError> {
        let crate::models::PromptAnswer::Single { value } = answer else {
            return Err(AgentError::Runtime("请选择一个选项".into()));
        };
        let options =
            plan_implementation_options(self.latest_plan.lock().unwrap().as_deref(), None);
        let Some(choice) = options.iter().find(|option| option.id == value.trim()) else {
            self.pending
                .lock()
                .unwrap()
                .insert(prompt_id.to_string(), Pending::ImplementPlan);
            return Err(AgentError::Runtime("请选择一个选项".into()));
        };
        if let Some(reason) = &choice.disabled_reason {
            self.pending
                .lock()
                .unwrap()
                .insert(prompt_id.to_string(), Pending::ImplementPlan);
            return Err(AgentError::Runtime(reason.clone()));
        }
        self.resolve_prompt(prompt_id, choice.label.clone());
        match choice.id.as_str() {
            IMPLEMENT_ID => {
                self.set_collaboration_mode("default")?;
                self.submit_user_text(PLAN_IMPLEMENTATION_CODING_MESSAGE.to_string())
                    .await
            }
            CLEAR_CONTEXT_ID => {
                let plan = self.latest_plan.lock().unwrap().clone().unwrap_or_default();
                emit(
                    &self.events,
                    SessionEventBody::NewThread {
                        name: None,
                        text: Some(format!(
                            "{PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX}\n\n{plan}"
                        )),
                    },
                );
                Ok(())
            }
            _ => Ok(()),
        }
    }
}
