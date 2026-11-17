//! 提问随原生进程存活；失效时写入数据库并通知订阅者。

use super::*;
use aiwb_core::models::PromptAnswer;

const EXPIRED_REPLY: &str = "提问已失效，回复未发送，请重新发送消息。";

impl Runtimes {
    pub(super) fn pending_prompt_ids(&self, session_id: &str) -> RuntimeResult<Vec<String>> {
        let mut logs = self.logs.lock().unwrap();
        if logs.contains_key(session_id) {
            let log = self.log_mut(&mut logs, session_id)?;
            return Ok(unresolved_ids(log.events.iter()));
        }
        drop(logs);
        if self.store.session(session_id).map_err(|e| e.to_string())?.is_none() {
            return Err("会话不存在".into());
        }
        let stored = self.store.events_since(session_id, 0).map_err(|e| e.to_string())?;
        Ok(unresolved_ids(stored.iter().map(|item| &item.event)))
    }

    pub(super) fn expire_prompts(&self, session_id: &str, only: Option<&str>) -> RuntimeResult<()> {
        for prompt_id in self.pending_prompt_ids(session_id)? {
            if only.is_some_and(|id| id != prompt_id) {
                continue;
            }
            self.record(session_id, SessionEventBody::PromptResolved {
                prompt_id,
                answer: "已失效".into(),
            })?;
        }
        Ok(())
    }

    pub(crate) async fn answer_prompt(
        &self,
        session_id: &str,
        prompt_id: &str,
        answer: PromptAnswer,
    ) -> RuntimeResult<()> {
        // 回答与空闲释放、重新连接共用会话锁，提交期间保留原生进程。
        let _opening = self.opening_of(session_id).lock_owned().await;
        let dismiss = matches!(&answer, PromptAnswer::Questions { skipped: true, .. });
        let Some(handle) = self.live_handle(session_id) else {
            self.expire_prompts(session_id, None)?;
            return if dismiss { Ok(()) } else { Err(EXPIRED_REPLY.into()) };
        };
        match handle.answer_prompt(prompt_id, answer).await {
            Ok(()) => Ok(()),
            Err(AgentError::UnknownPrompt(_)) => {
                self.expire_prompts(session_id, Some(prompt_id))?;
                if dismiss { Ok(()) } else { Err(EXPIRED_REPLY.into()) }
            }
            Err(AgentError::Closed) => {
                self.forget(session_id, &handle);
                self.expire_prompts(session_id, None)?;
                if dismiss { Ok(()) } else { Err(EXPIRED_REPLY.into()) }
            }
            Err(error) => Err(error.to_string()),
        }
    }
}

fn unresolved_ids<'a>(events: impl Iterator<Item = &'a SessionEvent> + Clone) -> Vec<String> {
    let resolved: HashSet<&str> = events.clone().filter_map(|event| match &event.body {
        SessionEventBody::PromptResolved { prompt_id, .. } => Some(prompt_id.as_str()),
        _ => None,
    }).collect();
    events.filter_map(|event| match &event.body {
        SessionEventBody::Prompt { prompt_id, .. } if !resolved.contains(prompt_id.as_str()) => {
            Some(prompt_id.clone())
        }
        _ => None,
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiwb_core::models::PromptKind;
    use aiwb_core::task::{Task, TaskSession};
    use std::time::Duration;

    fn runtime(path: &str) -> (Arc<Store>, Arc<Runtimes>) {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.insert_task(&Task {
            id: "t".into(), project_id: None, title: String::new(),
            workspace: TaskWorkspace::Folder { path: path.into() },
            pinned: false, archived_at: None, created_at: 1, updated_at: 1,
            parent_task_id: None,
        }, &TaskSession {
            id: "s".into(), task_id: "t".into(), agent: AgentKind::CodexCli,
            native_id: None, status: SessionStatus::Idle,
            options: SessionOptions::default(), created_at: 1, updated_at: 1,
        }).unwrap();
        let runtimes = Arc::new(Runtimes::new(
            store.clone(), Arc::new(Hub::new()), Arc::new(aiwb_agents::adapter_for),
        ));
        (store, runtimes)
    }

    fn skip() -> PromptAnswer {
        PromptAnswer::Questions { answers: HashMap::new(), skipped: true }
    }

    /// 真实 CLI 提问、空闲回收、关闭、重连和后续消息。
    #[tokio::test]
    #[ignore = "需要本机 Codex CLI 和登录状态"]
    async fn live_async_question_survives_idle_and_expires_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let (store, runtimes) = runtime(directory.path().to_str().unwrap());
        let question = "请调用 request_user_input_async，提出一个问题：按钮使用什么颜色？选项为红色、蓝色。调用完成后直接结束回合，最终回复：等待颜色选择。不要使用其他工具。";
        runtimes.send_message("s", Outgoing::user(
            question.into(),
            vec![], false,
        )).await.unwrap();
        let prompt_id = tokio::time::timeout(Duration::from_secs(180), async {
            loop {
                let pending = runtimes.pending_prompt_ids("s").unwrap();
                if store.session("s").unwrap().unwrap().status == SessionStatus::Completed {
                    if let Some(id) = pending.first() { break id.clone(); }
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }).await.expect("真实 CLI 必须完成异步提问回合");
        let original = runtimes.live_handle("s").unwrap();
        let events = store.events_since("s", 0).unwrap();
        assert!(events.iter().any(|item| matches!(&item.event.body,
            SessionEventBody::Prompt { prompt_id: id, prompt_kind: PromptKind::Questions, .. }
                if id == &prompt_id)));
        let idle_ms = 30 * 60 * 1000;
        assert_eq!(runtimes.release_idle(now_millis() + idle_ms + 1, idle_ms).await.unwrap(), 0);
        assert!(Arc::ptr_eq(&original, &runtimes.live_handle("s").unwrap()));

        runtimes.answer_prompt("s", &prompt_id, skip()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while !runtimes.pending_prompt_ids("s").unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.unwrap();
        assert_eq!(runtimes.release_idle(now_millis() + idle_ms + 1, idle_ms).await.unwrap(), 1);

        // 重放同一份真实提问事件，检查旧版本遗留的数据库状态。
        let (restarted_store, restarted) = runtime(directory.path().to_str().unwrap());
        restarted_store.set_session_native_id("s", &original.native_id().unwrap()).unwrap();
        for item in &events {
            restarted.record("s", item.event.body.clone()).unwrap();
        }
        let mut feed = restarted.hub.receiver();
        restarted.settle_interrupted().unwrap();
        assert!(restarted.pending_prompt_ids("s").unwrap().is_empty());
        assert_eq!(restarted_store.session("s").unwrap().unwrap().status, SessionStatus::Completed);
        let update = feed.try_recv().unwrap();
        let update: SessionFeed = serde_json::from_value(update.data.clone()).unwrap();
        assert!(update.events.iter().any(|item| matches!(&item.event.body,
            SessionEventBody::PromptResolved { prompt_id: id, answer } if id == &prompt_id && answer == "已失效")));
        restarted.answer_prompt("s", &prompt_id, skip()).await.unwrap();
        assert!(!restarted.is_live("s"));

        // 已重新连接的原生进程没有旧提问，接口必须发布失效事件。
        let (restarted_store, restarted) = runtime(directory.path().to_str().unwrap());
        restarted_store.set_session_native_id("s", &original.native_id().unwrap()).unwrap();
        restarted.ensure_live("s").await.unwrap();
        let prompt = events.iter().find(|item| matches!(&item.event.body,
            SessionEventBody::Prompt { prompt_id: id, .. } if id == &prompt_id)).unwrap();
        restarted.record("s", prompt.event.body.clone()).unwrap();
        let error = restarted.answer_prompt("s", &prompt_id, PromptAnswer::Single {
            value: "蓝色".into(),
        }).await.unwrap_err();
        assert_eq!(error, EXPIRED_REPLY);
        assert!(restarted.pending_prompt_ids("s").unwrap().is_empty());
        restarted.answer_prompt("s", &prompt_id, skip()).await.unwrap();
        restarted.send_message("s", Outgoing::user(
            "请直接回复：颜色选择流程已完成。不要调用工具。".into(), vec![], false,
        )).await.unwrap();
        tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                if restarted_store.session("s").unwrap().unwrap().status == SessionStatus::Completed
                    && restarted_store.events_since("s", 0).unwrap().iter().any(|item| matches!(&item.event.body,
                    SessionEventBody::AgentMessage { text, .. } if text.contains("颜色选择流程已完成"))) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }).await.expect("失效提问清除后必须能够继续对话");

        let main = restarted_store.session("s").unwrap().unwrap();
        restarted_store.add_side_session(&TaskSession {
            id: "side".into(), native_id: None, status: SessionStatus::Idle,
            ..main
        }).unwrap();
        restarted.set_viewing(1, Some("t".into())).unwrap();
        restarted.set_side_tabs(1, vec!["side".into()]);
        restarted.send_message("side", Outgoing::user(question.into(), vec![], false)).await.unwrap();
        tokio::time::timeout(Duration::from_secs(180), async {
            loop {
                if restarted_store.session("side").unwrap().unwrap().status == SessionStatus::Completed
                    && !restarted.pending_prompt_ids("side").unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }).await.expect("侧边聊天必须完成异步提问回合");
        assert_eq!(restarted.release_idle(now_millis() + idle_ms + 1, idle_ms).await.unwrap(), 0);
        assert!(restarted.is_live("side"));
        restarted.set_side_tabs(1, vec![]);
        assert_eq!(restarted.release_idle(now_millis() + idle_ms + 1, idle_ms).await.unwrap(), 1);
        assert!(!restarted.is_live("side"));
        assert!(restarted_store.session("side").unwrap().is_none());
        restarted.stop("s").await;
    }
}
