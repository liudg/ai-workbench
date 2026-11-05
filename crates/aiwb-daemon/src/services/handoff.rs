//! 中途换 Agent 和分叉聊天。前文怎么挑、怎么交在运行时里（`runtime/handoff.rs`）。

use aiwb_core::models::{new_id, AgentKind, HandoffStrategy, SessionEventBody, SessionStatus};
use aiwb_core::task::{SessionOptions, Task, TaskEntry, TaskSession, TaskWorkspace};
use serde::Deserialize;

use super::{now_millis, session_busy, ServiceResult, Services};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SwitchAgent {
    task_id: String,
    agent: AgentKind,
    #[serde(default)]
    options: SessionOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForkTask {
    task_id: String,
    /// 空表示和原来同一个 Agent。
    #[serde(default)]
    agent: Option<AgentKind>,
    /// 空时同一个 Agent 沿用原来的选项，换 Agent 用它自己的默认值。
    #[serde(default)]
    options: Option<SessionOptions>,
}

impl Services {
    /// 任务换一个 Agent 接着做。现在的会话留作前面的一段，新会话第一条消息带上前文。
    /// 这个 Agent 在任务里用过时接回它原来的线程，只补它没看到的那段。
    pub(crate) async fn switch_agent(&self, params: SwitchAgent) -> ServiceResult<TaskEntry> {
        let mut sessions = self
            .store
            .task_sessions(&params.task_id)
            .map_err(|e| e.to_string())?;
        let current = sessions.last().cloned().ok_or_else(|| "任务没有会话".to_string())?;
        if session_busy(&current) {
            return Err("这一轮还没结束，停下后再换 Agent".into());
        }
        self.ensure_handoff(current.agent, params.agent)?;
        // 交给了项目目录的任务以后还要交回工作树，换上去的 Agent 得能换目录接着会话。
        let handed_off = self
            .store
            .task(&params.task_id)
            .map_err(|e| e.to_string())?
            .is_some_and(|task| matches!(task.workspace, TaskWorkspace::Worktree { local: Some(_), .. }));
        if handed_off && !self.runtimes.adapter(params.agent).capabilities().supports_workdir_move {
            return Err(format!("{} 还不能换目录接着会话，先把任务交回工作树再换", params.agent.display_name()));
        }
        // 侧边聊天是从换下去的这段分出来的，跟着关掉。
        self.discard_side(&params.task_id).await?;

        // 刚换过来、还没说过话的会话不留：删掉它，从前一段接着换。
        if !self.has_spoken(&current.id)? {
            self.runtimes.discard(&current.id).await;
            self.discard_unsent_thread(&current, &sessions).await;
            if sessions.len() == 1 {
                self.store
                    .set_session_agent(&current.id, params.agent, &params.options)
                    .map_err(|e| e.to_string())?;
                self.runtimes.publish_tasks()?;
                return self.task_entry(&params.task_id);
            }
            self.store.remove_session(&current.id).map_err(|e| e.to_string())?;
            sessions.pop();
        }
        let current = sessions.last().cloned().expect("至少留下一段");
        if current.agent == params.agent {
            self.store
                .set_session_options(&current.id, &params.options)
                .map_err(|e| e.to_string())?;
            self.runtimes.publish_tasks()?;
            return self.task_entry(&params.task_id);
        }

        self.runtimes.stop(&current.id).await;
        let resume = sessions
            .iter()
            .rev()
            .find(|session| session.agent == params.agent)
            .and_then(|session| session.native_id.clone());
        let now = now_millis().max(current.created_at + 1);
        let next = TaskSession {
            id: new_id(),
            task_id: params.task_id.clone(),
            agent: params.agent,
            native_id: resume.clone(),
            status: SessionStatus::Completed,
            options: params.options,
            created_at: now,
            updated_at: now,
        };
        self.store.add_session(&next).map_err(|e| e.to_string())?;
        let strategy = if resume.is_some() {
            HandoffStrategy::Delta
        } else {
            HandoffStrategy::Full
        };
        self.runtimes.record_handoff(&next.id, &current, &next, strategy)?;
        self.runtimes.publish_tasks()?;
        self.task_entry(&params.task_id)
    }

    /// 从任务现在的样子分出一个新任务，在同一个目录里。
    /// 同一个 Agent 用它原生的分叉；换 Agent 或原生分叉不了时，新会话第一条消息带上全部前文。
    pub(crate) async fn fork_task(&self, params: ForkTask) -> ServiceResult<TaskEntry> {
        // 正在清理或交接源任务的工作树时，等它做完再照着它现在的样子分。
        let _worktrees = self.runtimes.worktrees.lock().await;
        let source = self.load_task(&params.task_id)?;
        let sessions = self
            .store
            .task_sessions(&source.id)
            .map_err(|e| e.to_string())?;
        let current = sessions.last().cloned().ok_or_else(|| "任务没有会话".to_string())?;
        if session_busy(&current) {
            return Err("这一轮还没结束，停下后再分叉".into());
        }
        let agent = params.agent.unwrap_or(current.agent);
        let adapter = self.runtimes.adapter(agent);
        if !adapter.session_linked() {
            return Err(format!("{} 还不能在工作台里对话", agent.display_name()));
        }
        // 还没交出去的前文在原线程里没有，这时原生分叉会丢掉它，改走交接。
        let pending = self.has_pending_handoff(&current.id)?;
        let native = match current.native_id.as_deref() {
            Some(native) if agent == current.agent && !pending && adapter.capabilities().supports_fork => {
                Some(adapter.fork_thread(native).await.map_err(|e| e.to_string())?.native_id)
            }
            _ => {
                self.ensure_handoff(current.agent, agent)?;
                None
            }
        };
        let options = params.options.unwrap_or_else(|| {
            if agent == current.agent {
                current.options.clone()
            } else {
                SessionOptions::default()
            }
        });
        let now = now_millis();
        let task = Task {
            id: new_id(),
            project_id: source.project_id.clone(),
            title: source.title.clone(),
            // 交给了项目目录的任务在项目目录里干活，分出来的也在项目目录，不共用那份交接记录。
            workspace: match &source.workspace {
                TaskWorkspace::Worktree { local: Some(_), .. } => TaskWorkspace::Root,
                other => other.clone(),
            },
            pinned: false,
            archived_at: None,
            created_at: now,
            updated_at: now,
            parent_task_id: None,
        };
        // 按原来的分段抄，每段还是原来的 Agent。原生分叉时最后一段接上分出来的线程；
        // 否则另起一段，第一条消息带上全部前文。
        let segment = |index: usize, agent: AgentKind, native_id: Option<String>, options: SessionOptions| TaskSession {
            id: new_id(),
            task_id: task.id.clone(),
            agent,
            native_id,
            status: SessionStatus::Completed,
            options,
            created_at: now + index as i64,
            updated_at: now + index as i64,
        };
        let last = sessions.len() - 1;
        let copies: Vec<TaskSession> = sessions
            .iter()
            .enumerate()
            .map(|(index, earlier)| match &native {
                Some(native) if index == last => segment(index, earlier.agent, Some(native.clone()), options.clone()),
                _ => segment(index, earlier.agent, None, earlier.options.clone()),
            })
            .collect();
        let target = native
            .is_none()
            .then(|| segment(sessions.len(), agent, None, options));
        self.store.insert_task(&task, &copies[0]).map_err(|e| e.to_string())?;
        for added in copies[1..].iter().chain(target.iter()) {
            self.store.add_session(added).map_err(|e| e.to_string())?;
        }
        for (earlier, copy) in sessions.iter().zip(&copies) {
            let events = self
                .store
                .events_since(&earlier.id, 0)
                .map_err(|e| e.to_string())?;
            self.runtimes
                .copy_events(&copy.id, events.into_iter().map(|stored| stored.event).collect())?;
        }
        if let Some(target) = &target {
            self.runtimes
                .record_handoff(&target.id, &current, target, HandoffStrategy::Full)?;
        }
        self.runtimes.publish_tasks()?;
        self.task_entry(&task.id)
    }

    /// 两边的适配器都能交接才行。
    fn ensure_handoff(&self, from: AgentKind, to: AgentKind) -> ServiceResult<()> {
        let target = self.runtimes.adapter(to);
        if !target.session_linked() {
            return Err(format!("{} 还不能在工作台里对话", to.display_name()));
        }
        for agent in [from, to] {
            if !self.runtimes.adapter(agent).capabilities().supports_context_handoff {
                return Err(format!("{} 不能和别的 Agent 交接", agent.display_name()));
            }
        }
        Ok(())
    }

    /// 没说过话的会话，CLI 可能已经为它开了空线程（要目录时就会接上）。不是接回别的段的线程就撤掉。
    async fn discard_unsent_thread(&self, session: &TaskSession, sessions: &[TaskSession]) {
        let Some(native) = session.native_id.as_deref() else {
            return;
        };
        let shared = sessions
            .iter()
            .any(|other| other.id != session.id && other.native_id.as_deref() == Some(native));
        if shared {
            return;
        }
        if let Err(err) = self.runtimes.adapter(session.agent).discard_unsent_thread(native).await {
            eprintln!("撤掉没用上的线程 {native} 失败：{err}");
        }
    }

    /// 会话里有没交出去的前文。
    pub(super) fn has_pending_handoff(&self, session_id: &str) -> ServiceResult<bool> {
        let events = self
            .store
            .events_since(session_id, 0)
            .map_err(|e| e.to_string())?;
        Ok(events
            .iter()
            .any(|stored| matches!(stored.event.body, SessionEventBody::Handoff { delivered: false, .. })))
    }

    /// 会话里发过消息没有。
    pub(super) fn has_spoken(&self, session_id: &str) -> ServiceResult<bool> {
        let events = self
            .store
            .events_since(session_id, 0)
            .map_err(|e| e.to_string())?;
        Ok(events
            .iter()
            .any(|stored| matches!(stored.event.body, SessionEventBody::UserMessage { .. })))
    }

    pub(crate) fn task_entry(&self, task_id: &str) -> ServiceResult<TaskEntry> {
        let mut entry = self
            .store
            .task_entries()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|entry| entry.task.id == task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        entry.branch = crate::runtime::task_branch(&entry.task);
        Ok(entry)
    }

    /// 另一个任务也在这个工作树里（分叉出来的）。`live_only` 时只算没归档的。
    pub(crate) fn worktree_shared(&self, task_id: &str, path: &str, live_only: bool) -> ServiceResult<bool> {
        let tasks = self.store.list_tasks().map_err(|e| e.to_string())?;
        Ok(tasks.iter().any(|task| {
            task.id != task_id
                && !(live_only && task.archived_at.is_some())
                && matches!(&task.workspace, TaskWorkspace::Worktree { path: other, .. } if other == path)
        }))
    }
}
