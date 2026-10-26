//! 任务：新建（主目录或工作树）、改名、归档、删除。

use std::path::Path;

use aiwb_core::models::{new_id, AgentKind, SessionStatus};
use aiwb_core::task::{SessionOptions, Task, TaskEntry, TaskSession, TaskWorkspace};
use serde::Deserialize;

use super::{now_millis, ServiceResult, Services};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateTask {
    project_id: String,
    #[serde(default)]
    title: String,
    /// 第一条消息。空表示只建任务，稍后再发。
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    images: Vec<String>,
    #[serde(default)]
    agent: Option<AgentKind>,
    #[serde(default)]
    worktree: bool,
    #[serde(default)]
    options: SessionOptions,
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
pub(crate) struct TaskId {
    id: String,
}

impl Services {
    /// 任务建好就返回。第一条消息在后台发出，CLI 起不来或发送失败时记进时间线。
    pub(crate) async fn create_task(&self, params: CreateTask) -> ServiceResult<TaskEntry> {
        let project = self
            .store
            .project(&params.project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "项目不存在".to_string())?;
        let agent = match params.agent {
            Some(agent) => agent,
            None => serde_json::from_value(serde_json::Value::String(project.default_agent.clone()))
                .unwrap_or(AgentKind::CodexCli),
        };
        if !self.runtimes.adapter(agent).session_linked() {
            return Err(format!("{} 还不能在工作台里对话", agent.display_name()));
        }
        let workspace = if params.worktree {
            let source = project.path.clone();
            let root = self.worktree_root.clone();
            let made = tokio::task::spawn_blocking(move || {
                aiwb_git::create_task_worktree(Path::new(&source), &root)
            })
            .await
            .map_err(|e| e.to_string())??;
            TaskWorkspace::Worktree {
                path: made.cwd.to_string_lossy().into_owned(),
                branch: made.branch,
                base_ref: made.base,
                base_sha: made.sha,
            }
        } else {
            TaskWorkspace::Root
        };
        let now = now_millis();
        let task = Task {
            id: new_id(),
            project_id: project.id,
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
        self.store
            .insert_task(&task, &session)
            .map_err(|e| e.to_string())?;
        self.runtimes.publish_tasks()?;

        if !params.prompt.trim().is_empty() || !params.images.is_empty() {
            let runtimes = self.runtimes.clone();
            let session_id = session.id.clone();
            tokio::spawn(async move {
                let sent = runtimes
                    .send(&session_id, params.prompt, params.images, false)
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
        self.store
            .task_entries()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|entry| entry.task.id == task.id)
            .ok_or_else(|| "任务没有建立".to_string())
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

    /// 删除任务和它的时间线。工作树目录留在磁盘上。
    pub(crate) async fn remove_task(&self, params: TaskId) -> ServiceResult<bool> {
        self.stop_task_sessions(&params.id).await?;
        let removed = self
            .store
            .remove_task(&params.id)
            .map_err(|e| e.to_string())?;
        self.runtimes.publish_tasks()?;
        Ok(removed)
    }

    pub(crate) async fn stop_task_sessions(&self, task_id: &str) -> ServiceResult<()> {
        let sessions = self.store.list_sessions().map_err(|e| e.to_string())?;
        for session in sessions.iter().filter(|session| session.task_id == task_id) {
            self.runtimes.stop(&session.id).await;
        }
        Ok(())
    }
}
