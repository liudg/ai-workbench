//! 任务：新建（主目录、工作树，或不属于项目的独立聊天）、改名、置顶、归档、删除。
//! 工作树的保留和清理在 `worktrees`。

use std::path::{Path, PathBuf};

use aiwb_core::models::{new_id, AgentKind, MessageSender, SessionEventBody, SessionStatus};
use aiwb_core::task::{SessionLink, SessionOptions, SessionSpec, Task, TaskEntry, TaskSession, TaskWorkspace};
use serde::{Deserialize, Serialize};

use super::{blocking, now_millis, ServiceResult, Services};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateTask {
    /// 空表示独立聊天。
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    title: String,
    /// 第一条消息。空表示只建任务，稍后再发。
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    images: Vec<String>,
    agent: AgentKind,
    #[serde(default)]
    worktree: bool,
    /// 工作树的起点分支。为空时用项目目录现在的提交。
    #[serde(default)]
    worktree_base: Option<String>,
    /// 把项目目录里没提交的改动带进工作树。
    #[serde(default)]
    carry_changes: bool,
    #[serde(default)]
    options: SessionOptions,
    /// 首发前先设好的目标。
    #[serde(default)]
    goal: Option<String>,
    /// `paused` 时目标设好后先暂停。
    #[serde(default)]
    goal_status: Option<String>,
    /// 开出这个子任务的任务。只由 Agent 经工作台 MCP 开子任务时设，界面不传。
    #[serde(skip)]
    parent_task_id: Option<String>,
    /// 第一条消息是哪个任务发来的。Agent 经工作台 MCP 开会话时设，界面不传。
    #[serde(skip)]
    sender_task_id: Option<String>,
    /// 独立聊天的子任务用父聊天的文件夹，不另建。界面不传。
    #[serde(skip)]
    folder: Option<String>,
}

impl CreateTask {
    /// Agent 开的会话：和发起的任务同一个项目，第一条消息就是说明。
    /// 独立聊天下的子任务用同一个文件夹，独立会话自己建。
    pub(super) fn from_agent(origin: &Task, link: SessionLink, spec: &SessionSpec) -> Self {
        let child = link == SessionLink::Child;
        let folder = match &origin.workspace {
            TaskWorkspace::Folder { path } if child => Some(path.clone()),
            _ => None,
        };
        Self {
            project_id: origin.project_id.clone(),
            title: spec.title.clone(),
            prompt: spec.prompt.clone(),
            images: Vec::new(),
            agent: spec.agent,
            worktree: spec.worktree,
            worktree_base: None,
            carry_changes: false,
            options: spec.options.clone(),
            goal: None,
            goal_status: None,
            parent_task_id: child.then(|| origin.id.clone()),
            sender_task_id: Some(origin.id.clone()),
            folder,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenameTask {
    id: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveTask {
    id: String,
    archived: bool,
}

#[derive(Deserialize)]
pub(crate) struct PinTask {
    id: String,
    pinned: bool,
}

#[derive(Deserialize)]
pub(crate) struct TaskId {
    pub(super) id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoveTask {
    id: String,
    /// 连工作台建的工作树一起删。
    #[serde(default)]
    discard_worktree: bool,
    /// 用户确认过丢掉工作树里没提交的改动。
    #[serde(default)]
    force_worktree: bool,
}

/// 删除前看一眼工作树：是不是工作台建的，有没有没保存的改动。
#[derive(Debug, Serialize)]
pub(crate) struct DeletePreview {
    owned: bool,
    dirty: bool,
}

impl Services {
    /// 任务建好就返回。目标和第一条消息在后台发出，CLI 起不来或发送失败时记进时间线。
    pub(crate) async fn create_task(&self, params: CreateTask) -> ServiceResult<TaskEntry> {
        let agent = params.agent;
        if !self.runtimes.adapter(agent).session_linked() {
            return Err(format!("{} 还不能在工作台里对话", agent.display_name()));
        }
        let (project_id, workspace) = match params.project_id.as_deref() {
            Some(project_id) => {
                let project = self
                    .store
                    .project(project_id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "项目不存在".to_string())?;
                let workspace = if params.worktree {
                    let source = project.path.clone();
                    let root = self.worktree_root()?;
                    let options = aiwb_git::NewWorktree {
                        base: params.worktree_base.clone(),
                        carry_changes: params.carry_changes,
                    };
                    let made = blocking(move || {
                        aiwb_git::create_task_worktree(Path::new(&source), &root, &options)
                    })
                    .await??;
                    TaskWorkspace::Worktree {
                        path: made.cwd.to_string_lossy().into_owned(),
                        branch: None,
                        base_ref: made.base,
                        base_sha: made.sha,
                        shelved: None,
                        local: None,
                    }
                } else {
                    TaskWorkspace::Root
                };
                (Some(project.id), workspace)
            }
            None => {
                if params.worktree {
                    return Err("独立聊天没有仓库，不能建工作树".into());
                }
                let path = match &params.folder {
                    Some(path) => path.clone(),
                    None => self.allocate_chat_dir(&params.prompt)?.to_string_lossy().into_owned(),
                };
                (None, TaskWorkspace::Folder { path })
            }
        };
        let now = now_millis();
        let goal = params.goal.map(|g| g.trim().to_string()).filter(|g| !g.is_empty());
        let task = Task {
            id: new_id(),
            project_id,
            title: if params.title.trim().is_empty() {
                aiwb_core::timeline::title_from_user_message(
                    goal.as_deref().unwrap_or(&params.prompt), params.images.len(), 0,
                ).unwrap_or_default()
            } else {
                params.title.trim().to_string()
            },
            workspace,
            parent_task_id: params.parent_task_id.clone(),
            pinned: false,
            archived_at: None,
            created_at: now,
            updated_at: now,
        };
        let sender = params.sender_task_id.clone().map(|origin| MessageSender { task_ids: vec![origin] });
        let has_message = !params.prompt.trim().is_empty() || !params.images.is_empty();
        let starting = has_message || goal.is_some();
        let mut messages = Vec::new();
        if let Some(goal) = &goal {
            messages.push(SessionEventBody::UserMessage {
                text: format!("/goal {goal}"),
                images: Vec::new(),
                annotations: 0,
                sender: None,
            });
        }
        if has_message {
            messages.push(SessionEventBody::UserMessage {
                text: params.prompt.clone(),
                images: params.images.clone(),
                annotations: 0,
                sender,
            });
        }
        let session = TaskSession {
            id: new_id(),
            task_id: task.id.clone(),
            agent,
            native_id: None,
            status: if starting { SessionStatus::Starting } else { SessionStatus::Idle },
            options: params.options,
            created_at: now,
            updated_at: now,
        };
        if let Err(err) = self.store.insert_task_with_messages(&task, &session, &messages) {
            // 只删这次新建的空文件夹，借用父聊天的不动。
            if let (TaskWorkspace::Folder { path }, None) = (&task.workspace, &params.folder) {
                let _ = std::fs::remove_dir(path);
            }
            return Err(err.to_string());
        }
        if starting {
            self.runtimes.start_initial(
                session.id.clone(),
                has_message.then(|| aiwb_agents::UserTurn {
                    text: params.prompt,
                    images: params.images,
                    client_id: new_id(),
                    annotations: Vec::new(),
                }),
                goal,
                params.goal_status.as_deref() == Some("paused"),
            );
        }
        self.runtimes.publish_tasks()?;
        if matches!(task.workspace, TaskWorkspace::Worktree { .. }) {
            self.request_worktree_sweep();
        }
        self.task_entry(&task.id)
    }

    pub(crate) fn rename_task(&self, params: RenameTask) -> ServiceResult<bool> {
        let title = params.title.trim();
        if title.is_empty() {
            return Err("标题不能为空".into());
        }
        let changed = self
            .store
            .set_task_title(&params.id, title, now_millis())
            .map_err(|e| e.to_string())?;
        self.runtimes.publish_tasks()?;
        Ok(changed)
    }

    pub(crate) fn pin_task(&self, params: PinTask) -> ServiceResult<bool> {
        let changed = self
            .store
            .set_task_pinned(&params.id, params.pinned)
            .map_err(|e| e.to_string())?;
        self.runtimes.publish_tasks()?;
        Ok(changed)
    }

    /// 归档时停掉它的 Agent 进程，取消归档后下次发送再接上。
    pub(crate) async fn archive_task(&self, params: ArchiveTask) -> ServiceResult<bool> {
        if params.archived {
            self.stop_task_sessions(&params.id).await?;
            self.forget_subtask(&params.id).await;
        } else {
            self.revive_subtask(&params.id);
        }
        let now = now_millis();
        let changed = self
            .store
            .set_task_archived(&params.id, params.archived.then_some(now), now)
            .map_err(|e| e.to_string())?;
        self.runtimes.publish_tasks()?;
        if params.archived {
            self.request_worktree_sweep();
        }
        Ok(changed)
    }

    /// 工作树任务才有可删的目录。主目录和独立聊天的文件夹不动。
    pub(crate) async fn delete_preview(&self, params: TaskId) -> ServiceResult<DeletePreview> {
        // 清理掉的工作树只剩快照，删了就找不回来，按有改动提醒。
        if self.task_snapshot_only(&params.id)? {
            return Ok(DeletePreview {
                owned: true,
                dirty: true,
            });
        }
        let Some((project, cwd)) = self.task_worktree(&params.id)? else {
            return Ok(DeletePreview {
                owned: false,
                dirty: false,
            });
        };
        let preview = blocking(move || aiwb_git::delete_preview(&project, &cwd)).await?;
        Ok(DeletePreview {
            owned: preview.owned,
            dirty: preview.dirty,
        })
    }

    /// 删除任务和它的时间线。要求时连工作树一起删；工作树删不干净也照样删任务。
    pub(crate) async fn remove_task(&self, params: RemoveTask) -> ServiceResult<bool> {
        // 正在清理、恢复或交接这个工作树时，等它做完再删，不留半个工作树或没人管的快照。
        let _worktrees = self.runtimes.worktrees.lock().await;
        self.stop_task_sessions(&params.id).await?;
        if params.discard_worktree {
            if let Some((project, cwd)) = self.task_worktree(&params.id)? {
                let force = params.force_worktree;
                blocking(move || aiwb_git::discard_confirmed_worktree(&project, &cwd, force)).await?;
            }
        }
        let sessions: Vec<String> = self
            .store
            .list_sessions()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|session| session.task_id == params.id)
            .map(|session| session.id)
            .collect();
        self.forget_subtask(&params.id).await;
        if params.discard_worktree {
            self.drop_task_snapshot(&params.id).await?;
        }
        let removed = self
            .store
            .remove_task(&params.id)
            .map_err(|e| e.to_string())?;
        self.terminals.close_owned(&sessions);
        self.runtimes.publish_tasks()?;
        Ok(removed)
    }

    /// 工作树清理掉了、只剩快照，并且没有分叉任务共用。
    fn task_snapshot_only(&self, task_id: &str) -> ServiceResult<bool> {
        let task = self.load_task(task_id)?;
        let TaskWorkspace::Worktree { path, shelved: Some(_), .. } = &task.workspace else {
            return Ok(false);
        };
        Ok(!self.worktree_shared(task_id, path, false)?)
    }

    /// 工作树任务的（项目主目录，检出目录）。分叉出来的任务还在用这个工作树时不算，目录不能删。
    fn task_worktree(&self, task_id: &str) -> ServiceResult<Option<(PathBuf, PathBuf)>> {
        let task = self.load_task(task_id)?;
        let TaskWorkspace::Worktree { path, .. } = task.workspace else {
            return Ok(None);
        };
        if self.worktree_shared(task_id, &path, false)? {
            return Ok(None);
        }
        let Some(project) = self.project_path(task.project_id.as_deref())? else {
            return Ok(None);
        };
        Ok(Some((project, PathBuf::from(path))))
    }

    /// 停掉任务的 Agent 进程。侧边聊天接不回去，一起关掉。
    pub(crate) async fn stop_task_sessions(&self, task_id: &str) -> ServiceResult<()> {
        self.discard_side(task_id).await?;
        let sessions = self.store.list_sessions().map_err(|e| e.to_string())?;
        for session in sessions.iter().filter(|session| session.task_id == task_id) {
            self.runtimes.stop(&session.id).await;
        }
        Ok(())
    }
}
