//! 中途换 Agent 和分叉聊天。前文怎么挑、怎么交在运行时里（`runtime/handoff.rs`）。

use std::path::Path;

use aiwb_core::models::{
    default_instance_id, effective_instance_id, new_id, AgentKind, HandoffStrategy, MessageSender,
    SessionEventBody, SessionStatus,
};
use aiwb_core::task::{SessionLink, SessionOptions, SessionSpec, Task, TaskEntry, TaskSession, TaskWorkspace};
use serde::Deserialize;

use super::{blocking, now_millis, session_busy, ServiceResult, Services};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SwitchAgent {
    task_id: String,
    agent: AgentKind,
    #[serde(default)]
    instance_id: Option<String>,
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
    #[serde(default)]
    instance_id: Option<String>,
    /// 空时同一个 Agent 沿用原来的选项，换 Agent 用它自己的默认值。
    #[serde(default)]
    options: Option<SessionOptions>,
}

fn normalized_instance_id(agent: AgentKind, instance_id: Option<&str>) -> Option<String> {
    let default_id = default_instance_id(agent);
    instance_id
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != default_id)
        .map(str::to_string)
}

impl Services {
    /// 任务换一个 Agent / 实例接着做。现在的会话留作前面的一段，新会话第一条消息带上前文。
    /// 同一个实例在任务里用过时接回它原来的线程，只补它没看到的那段。
    pub(crate) async fn switch_agent(&self, params: SwitchAgent) -> ServiceResult<TaskEntry> {
        let mut sessions = self
            .store
            .task_sessions(&params.task_id)
            .map_err(|e| e.to_string())?;
        let current = sessions.last().cloned().ok_or_else(|| "任务没有会话".to_string())?;
        if session_busy(&current) {
            return Err("这一轮还没结束，停下后再换 Agent".into());
        }
        let target_inst_opt = normalized_instance_id(params.agent, params.instance_id.as_deref());
        let target_inst_key =
            effective_instance_id(params.agent, target_inst_opt.as_deref()).to_string();
        self.ensure_handoff(
            (current.agent, current.instance_id.as_deref()),
            (params.agent, target_inst_opt.as_deref()),
        )?;
        // 交给了项目目录的任务以后还要交回工作树，换上去的 Agent 得能换目录接着会话。
        let handed_off = self
            .store
            .task(&params.task_id)
            .map_err(|e| e.to_string())?
            .is_some_and(|task| matches!(task.workspace, TaskWorkspace::Worktree { local: Some(_), .. }));
        if handed_off
            && !self
                .runtimes
                .adapter_for_instance(params.agent, target_inst_opt.as_deref())?
                .capabilities()
                .supports_workdir_move
        {
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
                    .set_session_agent_instance(
                        &current.id,
                        params.agent,
                        target_inst_opt.as_deref(),
                        &params.options,
                    )
                    .map_err(|e| e.to_string())?;
                self.runtimes.publish_tasks()?;
                return self.task_entry(&params.task_id);
            }
            self.store.remove_session(&current.id).map_err(|e| e.to_string())?;
            sessions.pop();
        }
        let current = sessions.last().cloned().expect("至少留下一段");
        if current.agent == params.agent && current.effective_instance_id() == target_inst_key {
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
            .find(|session| {
                session.agent == params.agent && session.effective_instance_id() == target_inst_key
            })
            .and_then(|session| session.native_id.clone());
        let now = now_millis().max(current.created_at + 1);
        let next = TaskSession {
            id: new_id(),
            task_id: params.task_id.clone(),
            agent: params.agent,
            instance_id: target_inst_opt,
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
    /// 同一个实例用它原生的分叉；换 Agent/实例或原生分叉不了时，新会话第一条消息带上全部前文。
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
        let target_inst_opt = if params.instance_id.is_some() {
            normalized_instance_id(agent, params.instance_id.as_deref())
        } else if params.agent.is_none() {
            current.instance_id.clone()
        } else {
            None
        };
        let same_instance = agent == current.agent
            && effective_instance_id(agent, target_inst_opt.as_deref())
                == current.effective_instance_id();
        let adapter = self
            .runtimes
            .adapter_for_instance(agent, target_inst_opt.as_deref())?;
        if !adapter.session_linked() {
            return Err(format!("{} 还不能在工作台里对话", agent.display_name()));
        }
        // 还没交出去的前文在原线程里没有，这时原生分叉会丢掉它，改走交接。
        let pending = self.has_pending_handoff(&current.id)?;
        let native = match current.native_id.as_deref() {
            Some(native) if same_instance && !pending && adapter.capabilities().supports_fork => {
                Some(adapter.fork_thread(native, None).await.map_err(|e| e.to_string())?.native_id)
            }
            _ => {
                self.ensure_handoff(
                    (current.agent, current.instance_id.as_deref()),
                    (agent, target_inst_opt.as_deref()),
                )?;
                None
            }
        };
        let options = params.options.unwrap_or_else(|| {
            if same_instance {
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
        self.copy_segments(
            &task,
            &sessions,
            native,
            agent,
            target_inst_opt,
            options,
            SessionStatus::Completed,
        )?;
        self.runtimes.publish_tasks()?;
        self.task_entry(&task.id)
    }

    /// Agent 开的分叉：新会话带着发起会话的完整对话，再收到任务。发起的会话这时正在回合里（它在调工具）。
    /// 照 Claude Code 桌面版 `start_session` 的 `fork`：工作树里的会话分到新工作树，从它现在的提交切出来，没提交的改动留在原地。
    pub(super) async fn fork_for_agent(
        &self,
        origin: &Task,
        origin_session_id: &str,
        link: SessionLink,
        spec: &SessionSpec,
        notes: Option<String>,
    ) -> ServiceResult<TaskEntry> {
        let _worktrees = self.runtimes.worktrees.lock().await;
        let sessions = self.store.task_sessions(&origin.id).map_err(|e| e.to_string())?;
        let current = sessions.last().cloned().ok_or_else(|| "任务没有会话".to_string())?;
        if current.id != origin_session_id || current.agent != spec.agent {
            return Err("发起分叉的会话已切换，请重新发起分叉".into());
        }
        let adapter = self.runtimes.session_adapter(&current)?;
        let native = current
            .native_id
            .clone()
            .filter(|_| !self.has_pending_handoff(&current.id).unwrap_or(true))
            .ok_or_else(|| "fork_unavailable: your conversation cannot be forked right now; do not fork and give background".to_string())?;
        let (workspace, made) = self.fork_workspace(origin).await?;
        let forked = match adapter.fork_thread(&native, made.as_deref()).await {
            Ok(entry) => entry.native_id,
            Err(err) => {
                if let (Some(cwd), Some(project)) = (made, self.origin_project_path(origin)?) {
                    let _ = blocking(move || aiwb_git::discard_confirmed_worktree(Path::new(&project), Path::new(&cwd), true)).await;
                }
                return Err(err.to_string());
            }
        };
        let mut options = current.options.clone();
        options.access = spec.options.access.clone();
        let options = super::agent_sessions::with_notes(options, notes.as_deref());
        let now = now_millis();
        let task = Task {
            id: new_id(),
            project_id: origin.project_id.clone(),
            title: spec.title.clone(),
            workspace,
            parent_task_id: (link == SessionLink::Child).then(|| origin.id.clone()),
            pinned: false,
            archived_at: None,
            created_at: now,
            updated_at: now,
        };
        let session = self.copy_segments(
            &task,
            &sessions,
            Some(forked),
            current.agent,
            current.instance_id.clone(),
            options,
            SessionStatus::Starting,
        )?;
        let sender = MessageSender {
            task_ids: vec![origin.id.clone()],
            background: None,
            notes,
            fork: true,
        };
        let text = sender.agent_text(&spec.prompt);
        self.runtimes.record(
            &session.id,
            SessionEventBody::UserMessage {
                text: spec.prompt.clone(),
                images: Vec::new(),
                annotations: 0,
                sender: Some(sender),
            },
        )?;
        self.runtimes.start_initial(
            session.id,
            Some(aiwb_agents::UserTurn {
                text,
                images: Vec::new(),
                client_id: new_id(),
                annotations: Vec::new(),
            }),
            None,
            false,
        );
        self.runtimes.publish_tasks()?;
        if matches!(task.workspace, TaskWorkspace::Worktree { .. }) {
            self.request_worktree_sweep();
        }
        self.task_entry(&task.id)
    }

    /// 分叉在哪干活，以及新建工作树时的目录。交给了项目目录的任务也在项目目录里。
    async fn fork_workspace(&self, origin: &Task) -> ServiceResult<(TaskWorkspace, Option<String>)> {
        let TaskWorkspace::Worktree { path, local: None, .. } = &origin.workspace else {
            let workspace = match &origin.workspace {
                TaskWorkspace::Worktree { .. } => TaskWorkspace::Root,
                other => other.clone(),
            };
            return Ok((workspace, None));
        };
        let source = path.clone();
        let root = self.worktree_root()?;
        let options = aiwb_git::NewWorktree { base: None, carry_changes: false };
        let made = blocking(move || aiwb_git::create_task_worktree(Path::new(&source), &root, &options)).await??;
        let cwd = made.cwd.to_string_lossy().into_owned();
        let workspace = TaskWorkspace::Worktree {
            path: cwd.clone(),
            branch: None,
            base_ref: made.base,
            base_sha: made.sha,
            shelved: None,
            local: None,
        };
        Ok((workspace, Some(cwd)))
    }

    fn origin_project_path(&self, origin: &Task) -> ServiceResult<Option<String>> {
        let Some(id) = origin.project_id.as_deref() else {
            return Ok(None);
        };
        Ok(self.store.project(id).map_err(|e| e.to_string())?.map(|project| project.path))
    }

    /// 按原来的分段抄进新任务，每段还是原来的 Agent。原生分叉时最后一段接上分出来的线程；
    /// 否则另起一段，第一条消息带上全部前文。返回现在用的那段。
    fn copy_segments(
        &self,
        task: &Task,
        sessions: &[TaskSession],
        native: Option<String>,
        agent: AgentKind,
        instance_id: Option<String>,
        options: SessionOptions,
        status: SessionStatus,
    ) -> ServiceResult<TaskSession> {
        let current = sessions.last().cloned().ok_or_else(|| "任务没有会话".to_string())?;
        let now = task.created_at;
        let target_index = if native.is_some() { sessions.len() - 1 } else { sessions.len() };
        let segment = |index: usize,
                       agent: AgentKind,
                       inst_id: Option<String>,
                       native_id: Option<String>,
                       options: SessionOptions| TaskSession {
            id: new_id(),
            task_id: task.id.clone(),
            agent,
            instance_id: inst_id,
            native_id,
            // 复制的历史段不会启动进程，只有当前目标段使用启动状态。
            status: if index == target_index {
                status
            } else {
                SessionStatus::Completed
            },
            options,
            created_at: now + index as i64,
            updated_at: now + index as i64,
        };
        let last = sessions.len() - 1;
        let copies: Vec<TaskSession> = sessions
            .iter()
            .enumerate()
            .map(|(index, earlier)| match &native {
                Some(native) if index == last => segment(
                    index,
                    earlier.agent,
                    instance_id.clone().or_else(|| earlier.instance_id.clone()),
                    Some(native.clone()),
                    options.clone(),
                ),
                _ => segment(
                    index,
                    earlier.agent,
                    earlier.instance_id.clone(),
                    None,
                    earlier.options.clone(),
                ),
            })
            .collect();
        let target = native
            .is_none()
            .then(|| segment(sessions.len(), agent, instance_id, None, options));
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
        Ok(target.or_else(|| copies.last().cloned()).expect("至少有一段"))
    }

    /// 两边的适配器都能交接才行（源实例已被删除时按同种 Agent 静态能力检查，允许用户把旧任务切到可用实例）。
    fn ensure_handoff(
        &self,
        from: (AgentKind, Option<&str>),
        to: (AgentKind, Option<&str>),
    ) -> ServiceResult<()> {
        let target = self.runtimes.adapter_for_instance(to.0, to.1)?;
        if !target.session_linked() {
            return Err(format!("{} 还不能在工作台里对话", to.0.display_name()));
        }
        let from_adapter = self
            .runtimes
            .adapter_for_instance(from.0, from.1)
            .unwrap_or_else(|_| self.runtimes.adapter(from.0));
        if !from_adapter.capabilities().supports_context_handoff {
            return Err(format!("{} 不能和别的 Agent 交接", from.0.display_name()));
        }
        if !target.capabilities().supports_context_handoff {
            return Err(format!("{} 不能和别的 Agent 交接", to.0.display_name()));
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
        let Ok(adapter) = self.runtimes.session_adapter(session) else {
            return;
        };
        if let Err(err) = adapter.discard_unsent_thread(native).await {
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
