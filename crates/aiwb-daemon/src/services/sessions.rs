//! 会话操作：发送、停止、回答提问、排队、选项、目录和权限菜单。

use aiwb_agents::{TurnDelivery, UserTurn};
use aiwb_core::models::{
    AgentCatalog, PageAnnotation, PermissionMenu, PromptAnswer, ReviewStart, ReviewTargets,
    SubscriptionUsage,
};
use aiwb_core::models::AgentKind;
use aiwb_core::task::{SessionOptions, TaskWorkspace};
use serde::Deserialize;

use super::agents::AgentParam;
use super::{ServiceResult, Services};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionId {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubagentId {
    session_id: String,
    subagent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundTaskId {
    session_id: String,
    task_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Send {
    session_id: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    images: Vec<String>,
    /// 回合进行中也立刻送进去（引导），不排队。
    #[serde(default)]
    now: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Answer {
    session_id: String,
    prompt_id: String,
    answer: PromptAnswer,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Queued {
    session_id: String,
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlushQueued {
    session_id: String,
    ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateQueued {
    session_id: String,
    id: String,
    text: String,
    #[serde(default)]
    images: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetOptions {
    session_id: String,
    options: SessionOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartReview {
    session_id: String,
    target: ReviewStart,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Annotation {
    session_id: String,
    note: PageAnnotation,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Goal {
    session_id: String,
    objective: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GoalStatus {
    session_id: String,
    /// `paused` 或 `active`。
    status: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sent {
    /// 回合进行中排进了队列。
    queued: bool,
}

impl Services {
    pub(crate) async fn send(&self, params: Send) -> ServiceResult<Sent> {
        let first_turn_meta = if aiwb_core::models::is_visible_user_text(&params.text) {
            self.store
                .session(&params.session_id)
                .ok()
                .flatten()
                .and_then(|s| {
                    let is_side = self.store.is_side_session(&s.id).unwrap_or(false);
                    if is_side {
                        return None;
                    }
                    let spoke = self.has_spoken(&s.id).unwrap_or(true);
                    let earlier_segs = self
                        .store
                        .task_sessions(&s.task_id)
                        .map(|segs| segs.len() > 1)
                        .unwrap_or(true);
                    (!spoke && !earlier_segs).then_some((s.task_id, s.agent, s.instance_id))
                })
        } else {
            None
        };
        let seed_text = params.text.clone();
        let message = crate::runtime::Outgoing::user(params.text, params.images, params.now);
        let delivery = self.send_from_user(&params.session_id, message).await?;
        if delivery == TurnDelivery::Started {
            if let Some((task_id, agent, instance_id)) = first_turn_meta {
                self.spawn_auto_title(task_id, seed_text, agent, instance_id);
            }
        }
        Ok(Sent {
            queued: delivery == TurnDelivery::Queued,
        })
    }

    /// 内置浏览器里的页面批注，交给 Agent。排队时不画用户气泡，等真正发出时由适配器记。
    pub(crate) async fn submit_annotation(&self, params: Annotation) -> ServiceResult<Sent> {
        let delivery = self
            .runtimes
            .submit_annotation(&params.session_id, params.note)
            .await?;
        Ok(Sent {
            queued: delivery == TurnDelivery::Queued,
        })
    }

    pub(crate) async fn interrupt(&self, params: SessionId) -> ServiceResult<()> {
        self.runtimes.interrupt(&params.session_id).await
    }

    /// 单独停掉 Agent 自带的一个子 Agent。会话没接上时它也不在跑。
    pub(crate) async fn stop_subagent(&self, params: SubagentId) -> ServiceResult<()> {
        let Some(handle) = self.runtimes.live_handle(&params.session_id) else {
            return Ok(());
        };
        handle.stop_subagent(&params.subagent_id).await.map_err(|e| e.to_string())
    }

    /// 单独停掉一个后台任务。会话没接上时它也不在跑。
    pub(crate) async fn stop_background_task(&self, params: BackgroundTaskId) -> ServiceResult<()> {
        let Some(handle) = self.runtimes.live_handle(&params.session_id) else {
            return Ok(());
        };
        handle.stop_background_task(&params.task_id).await.map_err(|e| e.to_string())
    }

    pub(crate) async fn answer(&self, params: Answer) -> ServiceResult<()> {
        self.runtimes
            .answer_prompt(&params.session_id, &params.prompt_id, params.answer)
            .await
    }

    pub(crate) async fn update_queued(&self, params: UpdateQueued) -> ServiceResult<()> {
        let turn = UserTurn {
            text: params.text,
            images: params.images,
            client_id: String::new(),
            annotations: Vec::new(),
        };
        let id = params.id;
        self.runtimes
            .with_handle(&params.session_id, move |handle| {
                let (id, turn) = (id.clone(), turn.clone());
                async move { handle.update_queued(&id, turn).await }
            })
            .await
    }

    pub(crate) async fn remove_queued(&self, params: Queued) -> ServiceResult<()> {
        let id = params.id;
        self.runtimes
            .with_handle(&params.session_id, move |handle| {
                let id = id.clone();
                async move { handle.remove_queued(&id).await }
            })
            .await
    }

    pub(crate) async fn steer_queued(&self, params: Queued) -> ServiceResult<()> {
        let _ = self.runtimes.handle(&params.session_id).await?;
        let is_idle = self
            .store
            .session(&params.session_id)
            .ok()
            .flatten()
            .is_some_and(|s| !super::session_busy(&s));
        if is_idle {
            if let Some(pre) = self.runtimes.capture_pre_checkpoint(&params.session_id).await {
                self.runtimes
                    .stash_pending_pre_checkpoint(&params.session_id, pre);
            }
        }
        let id = params.id;
        let result = self
            .runtimes
            .with_handle(&params.session_id, move |handle| {
                let id = id.clone();
                async move { handle.steer_queued(&id).await }
            })
            .await;
        if result.is_err() {
            self.runtimes
                .clear_pending_pre_checkpoint(&params.session_id);
        }
        result
    }

    /// 按给定顺序把排队的消息逐条引导进当前回合。
    pub(crate) async fn flush_queued(&self, params: FlushQueued) -> ServiceResult<()> {
        // 送到一半断了的话前几条已经发出，整组重试会漏掉后面的：不重试。
        let handle = self.runtimes.handle(&params.session_id).await?;
        let is_idle = self
            .store
            .session(&params.session_id)
            .ok()
            .flatten()
            .is_some_and(|s| !super::session_busy(&s));
        if is_idle {
            if let Some(pre) = self.runtimes.capture_pre_checkpoint(&params.session_id).await {
                self.runtimes
                    .stash_pending_pre_checkpoint(&params.session_id, pre);
            }
        }
        let result = handle
            .flush_queued(params.ids)
            .await
            .map_err(|e| e.to_string());
        if result.is_err() {
            self.runtimes
                .clear_pending_pre_checkpoint(&params.session_id);
        }
        result
    }

    pub(crate) async fn set_options(&self, params: SetOptions) -> ServiceResult<()> {
        self.runtimes.set_options(&params.session_id, &params.options).await
    }

    /// 模型、推理强度、技能。要接上 CLI 才拿得到。拿到了就记下来，给该实例的新会话用。
    pub(crate) async fn catalog(&self, params: SessionId) -> ServiceResult<AgentCatalog> {
        if let Some((agent, inst_id)) = self.shelved_agent_instance(&params.session_id)? {
            return Ok(self
                .stored_catalog_for(agent, inst_id.as_deref())?
                .unwrap_or_else(AgentCatalog::empty));
        }
        let mut catalog = self
            .runtimes
            .with_handle(&params.session_id, |handle| async move { handle.catalog().await })
            .await?;
        if let Some(session) = self.store.session(&params.session_id).map_err(|e| e.to_string())? {
            if catalog.instance_id.is_none() {
                catalog.instance_id = session.instance_id.clone();
            }
            self.runtimes.remember_catalog_for(
                session.agent,
                session.instance_id.as_deref(),
                &catalog,
            );
        }
        Ok(catalog)
    }

    pub(crate) async fn set_goal(&self, params: Goal) -> ServiceResult<()> {
        self.runtimes.set_goal(&params.session_id, &params.objective).await
    }

    pub(crate) async fn clear_goal(&self, params: SessionId) -> ServiceResult<()> {
        self.runtimes
            .with_handle(&params.session_id, |handle| async move { handle.clear_goal().await })
            .await
    }

    pub(crate) async fn set_goal_status(&self, params: GoalStatus) -> ServiceResult<()> {
        let status = params.status;
        self.runtimes
            .with_handle(&params.session_id, move |handle| {
                let status = status.clone();
                async move { handle.set_goal_status(&status).await }
            })
            .await
    }

    /// 把当前目标再推给 Agent 一次。
    pub(crate) async fn publish_goal(&self, params: SessionId) -> ServiceResult<()> {
        // 打开会话时会推一次。工作树清理掉了就先不推，等恢复后再接上。
        if self.shelved_agent(&params.session_id)?.is_some() {
            return Ok(());
        }
        self.runtimes
            .with_handle(&params.session_id, |handle| async move { handle.publish_goal().await })
            .await
    }

    pub(crate) async fn permission_menu(&self, params: SessionId) -> ServiceResult<PermissionMenu> {
        if let Some((agent, inst_id)) = self.shelved_agent_instance(&params.session_id)? {
            return Ok(self
                .runtimes
                .adapter_for_instance(agent, inst_id.as_deref())?
                .draft_permission_menu());
        }
        self.runtimes
            .with_handle(&params.session_id, |handle| async move { handle.permission_menu().await })
            .await
    }

    /// 当前账号的订阅额度。只有声明了 `supports_subscription_usage` 的 Agent 有。
    pub(crate) async fn subscription_usage(&self, params: AgentParam) -> ServiceResult<SubscriptionUsage> {
        self.runtimes
            .adapter_for_instance(params.agent, params.instance_id.as_deref())?
            .subscription_usage()
            .await
            .map_err(|e| e.to_string())
    }

    /// 工作树已被清理、CLI 也没接着时是会话的 Agent。照 Codex，打开任务只给「恢复」，
    /// 不为了读模型、权限菜单和目标把工作树建回来；发消息或点恢复时才建。
    pub(crate) fn shelved_agent(&self, session_id: &str) -> ServiceResult<Option<AgentKind>> {
        Ok(self.shelved_agent_instance(session_id)?.map(|(a, _)| a))
    }

    pub(crate) fn shelved_agent_instance(
        &self,
        session_id: &str,
    ) -> ServiceResult<Option<(AgentKind, Option<String>)>> {
        if self.runtimes.is_live(session_id) {
            return Ok(None);
        }
        let Some(session) = self.store.session(session_id).map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        let task = self.store.task(&session.task_id).map_err(|e| e.to_string())?;
        let shelved = matches!(
            task.map(|task| task.workspace),
            Some(TaskWorkspace::Worktree { shelved: Some(_), local: None, .. })
        );
        Ok(shelved.then_some((session.agent, session.instance_id)))
    }

    /// 还没有任务时的权限菜单，不启动 CLI。
    pub(crate) fn draft_permission_menu(&self, params: AgentParam) -> ServiceResult<PermissionMenu> {
        Ok(self
            .runtimes
            .adapter_for_instance(params.agent, params.instance_id.as_deref())?
            .draft_permission_menu())
    }

    pub(crate) async fn review_targets(&self, params: SessionId) -> ServiceResult<ReviewTargets> {
        self.runtimes
            .with_handle(&params.session_id, |handle| async move { handle.review_targets().await })
            .await
    }

    /// 代码审查。用户消息由适配器写进时间线。
    pub(crate) async fn start_review(&self, params: StartReview) -> ServiceResult<()> {
        let target = params.target;
        self.runtimes
            .with_writer(&params.session_id, move |handle| {
                let target = target.clone();
                async move { handle.start_review(target).await }
            })
            .await
    }

    pub(crate) async fn stop_session(&self, params: SessionId) -> ServiceResult<()> {
        self.runtimes.stop(&params.session_id).await;
        Ok(())
    }
}
