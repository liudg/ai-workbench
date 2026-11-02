//! 任务：新建（主目录、工作树，或不属于项目的独立聊天）、改名、置顶、归档、删除。

use std::path::{Path, PathBuf};

use aiwb_core::models::{new_id, AgentKind, SessionStatus};
use aiwb_core::task::{SessionOptions, Task, TaskEntry, TaskSession, TaskWorkspace};
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
    #[serde(default)]
    options: SessionOptions,
    /// 首发前先设好的目标。
    #[serde(default)]
    goal: Option<String>,
    /// `paused` 时目标设好后先暂停。
    #[serde(default)]
    goal_status: Option<String>,
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
    id: String,
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
                    let root = self.worktree_root.clone();
                    let made =
                        blocking(move || aiwb_git::create_task_worktree(Path::new(&source), &root)).await??;
                    TaskWorkspace::Worktree {
                        path: made.cwd.to_string_lossy().into_owned(),
                        branch: made.branch,
                        base_ref: made.base,
                        base_sha: made.sha,
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
                let dir = self.allocate_chat_dir(&params.prompt)?;
                (
                    None,
                    TaskWorkspace::Folder {
                        path: dir.to_string_lossy().into_owned(),
                    },
                )
            }
        };
        let now = now_millis();
        let task = Task {
            id: new_id(),
            project_id,
            title: params.title.trim().to_string(),
            workspace,
            pinned: false,
            archived_at: None,
            created_at: now,
            updated_at: now,
        };
        let session = TaskSession {
            id: new_id(),
            task_id: task.id.clone(),
            agent,
            native_id: None,
            status: SessionStatus::Completed,
            options: params.options,
            created_at: now,
            updated_at: now,
        };
        if let Err(err) = self.store.insert_task(&task, &session) {
            if let TaskWorkspace::Folder { path } = &task.workspace {
                let _ = std::fs::remove_dir(path);
            }
            return Err(err.to_string());
        }
        self.runtimes.publish_tasks()?;

        let goal = params
            .goal
            .map(|goal| goal.trim().to_string())
            .filter(|goal| !goal.is_empty());
        if !params.prompt.trim().is_empty() || !params.images.is_empty() || goal.is_some() {
            let runtimes = self.runtimes.clone();
            let session_id = session.id.clone();
            let paused = params.goal_status.as_deref() == Some("paused");
            tokio::spawn(async move {
                let sent = async {
                    if let Some(goal) = goal {
                        runtimes.set_goal(&session_id, &goal).await?;
                        if paused {
                            let handle = runtimes.handle(&session_id).await?;
                            handle.set_goal_status("paused").await.map_err(|e| e.to_string())?;
                        }
                    }
                    if params.prompt.trim().is_empty() && params.images.is_empty() {
                        return Ok(());
                    }
                    runtimes
                        .send(&session_id, params.prompt, params.images, false)
                        .await
                        .map(|_| ())
                }
                .await;
                if let Err(message) = sent {
                    if runtimes.is_live(&session_id) {
                        let _ = runtimes.record(
                            &session_id,
                            aiwb_core::models::SessionEventBody::Error { message },
                        );
                    }
                }
            });
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
        }
        let now = now_millis();
        let changed = self
            .store
            .set_task_archived(&params.id, params.archived.then_some(now), now)
            .map_err(|e| e.to_string())?;
        self.runtimes.publish_tasks()?;
        Ok(changed)
    }

    /// 工作树任务才有可删的目录。主目录和独立聊天的文件夹不动。
    pub(crate) async fn delete_preview(&self, params: TaskId) -> ServiceResult<DeletePreview> {
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
        let removed = self
            .store
            .remove_task(&params.id)
            .map_err(|e| e.to_string())?;
        self.terminals.close_owned(&sessions);
        self.runtimes.publish_tasks()?;
        Ok(removed)
    }

    /// 工作树任务的（项目主目录，检出目录）。分叉出来的任务还在用这个工作树时不算，目录不能删。
    fn task_worktree(&self, task_id: &str) -> ServiceResult<Option<(PathBuf, PathBuf)>> {
        let task = self
            .store
            .task(task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "任务不存在".to_string())?;
        let TaskWorkspace::Worktree { path, .. } = task.workspace else {
            return Ok(None);
        };
        if self.worktree_shared(task_id, &path)? {
            return Ok(None);
        }
        let Some(project_id) = task.project_id else {
            return Ok(None);
        };
        let Some(project) = self.store.project(&project_id).map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        Ok(Some((PathBuf::from(project.path), PathBuf::from(path))))
    }

    pub(crate) async fn stop_task_sessions(&self, task_id: &str) -> ServiceResult<()> {
        let sessions = self.store.list_sessions().map_err(|e| e.to_string())?;
        for session in sessions.iter().filter(|session| session.task_id == task_id) {
            self.runtimes.stop(&session.id).await;
        }
        Ok(())
    }
}
