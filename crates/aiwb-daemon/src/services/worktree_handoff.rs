//! 工作树任务交给项目目录、再交回工作树，照 Codex 桌面版的 Hand off（docs/worktree-lifecycle.md）。
//! 分支和没提交的改动跟着挪，会话换到新目录接着干（Claude、Codex 换目录 resume 都实测过）。

use std::path::PathBuf;

use aiwb_core::models::SessionEventBody;
use aiwb_core::task::{Task, TaskEntry, TaskWorkspace};
use serde::Deserialize;

use super::{blocking, session_busy, ServiceResult, Services};

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HandOffTarget {
    Local,
    Worktree,
}

#[derive(Deserialize)]
pub(crate) struct HandOff {
    id: String,
    to: HandOffTarget,
    /// 工作树还没有分支时，交给项目目录前在工作树里建的分支。
    #[serde(default)]
    branch: Option<String>,
}

impl Services {
    /// 全程拿着工作树锁：期间不清理、不恢复，会话也要等交接完才能启动。
    pub(crate) async fn hand_off_task(&self, params: HandOff) -> ServiceResult<TaskEntry> {
        let _lock = self.runtimes.worktrees.lock().await;
        let task = self.load_task(&params.id)?;
        let TaskWorkspace::Worktree { path, local, .. } = &task.workspace else {
            return Err("这个任务不在工作树里".into());
        };
        match (params.to, local) {
            (HandOffTarget::Local, Some(_)) => return Err("任务已经在项目目录里了".into()),
            (HandOffTarget::Worktree, None) => return Err("任务已经在工作树里了".into()),
            _ => {}
        }
        if self.worktree_shared(&task.id, path, true)? {
            return Err("还有分叉出来的任务在用这个工作树，没法交接".into());
        }
        self.check_agent_moves(&task)?;
        let neighbours = self.check_project_free(&task, params.to).await?;
        let project = self
            .project_path(task.project_id.as_deref())?
            .ok_or_else(|| "项目不存在".to_string())?;
        // 工作树被清理过就先放回来。
        self.runtimes.restore_worktree_locked(&task.id).await?;
        self.stop_task_sessions(&task.id).await?;
        let sessions: Vec<String> = self
            .store
            .task_sessions(&task.id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|session| session.id)
            .collect();
        // 终端开在要被改动的目录里，交接前关掉。
        self.terminals.close_owned(&sessions);
        // 在同一个仓库检出里干活的任务这会儿都闲着，把它们接着的 CLI 也停掉：
        // 交接期间它们发消息要重新接上，接上要等工作树锁，就等到交接做完。
        for other in &neighbours {
            for session in self.store.task_sessions(other).map_err(|e| e.to_string())? {
                self.runtimes.stop(&session.id).await;
            }
        }

        let mut task = self.load_task(&params.id)?;
        let TaskWorkspace::Worktree { path, local, .. } = &mut task.workspace else {
            return Err("这个任务不在工作树里".into());
        };
        let worktree = PathBuf::from(path.as_str());
        let note = match params.to {
            HandOffTarget::Local => {
                let branch = params.branch.clone();
                let record = blocking(move || {
                    aiwb_git::hand_off_to_local(&project, &worktree, branch.as_deref())
                })
                .await??;
                let note = format!("已交给项目目录，分支 {}", record.branch);
                *local = Some(record);
                note
            }
            HandOffTarget::Worktree => {
                // 上面已在同一把锁下核对过是交出去的状态。
                let Some(record) = local.take() else {
                    return Err("任务已经在工作树里了".into());
                };
                let branch = record.branch.clone();
                let moved =
                    blocking(move || aiwb_git::hand_back_to_worktree(&project, &worktree, &record)).await??;
                match moved {
                    Some(files) if files.is_empty() => "已交回工作树".to_string(),
                    Some(files) => format!(
                        "已交回工作树，从项目目录带走了没提交的文件：{}",
                        aiwb_git::list_files(&files)
                    ),
                    None => format!("已交回工作树。项目目录已经不在分支 {branch} 上，没有动它"),
                }
            }
        };
        self.store
            .set_task_workspace(&task.id, &task.workspace)
            .map_err(|e| e.to_string())?;
        if let Some(session) = sessions.last() {
            self.runtimes
                .record(session, SessionEventBody::System { text: note })?;
        }
        self.runtimes.publish_tasks()?;
        self.task_entry(&task.id)
    }

    /// 交接后会话要在别的目录里接着原来的会话，Agent 得支持换目录 resume。
    fn check_agent_moves(&self, task: &Task) -> ServiceResult<()> {
        let sessions = self.store.task_sessions(&task.id).map_err(|e| e.to_string())?;
        let Some(session) = sessions.last() else {
            return Ok(());
        };
        let adapter = self.runtimes.adapter(session.agent);
        if adapter.capabilities().supports_workdir_move {
            return Ok(());
        }
        Err(format!("{} 还不能换目录接着会话，没法交接", session.agent.display_name()))
    }

    /// 交接会切项目目录的分支，影响同一个仓库里的所有项目（仓库根和它的子目录）：
    /// 这个任务和在这个仓库检出里干活的任务都不能在跑；已经有别的任务交给了它时不能再交一个过来
    /// （归档了的也算，它的分支还占着检出）。返回在这个检出里干活的其他任务。
    async fn check_project_free(&self, task: &Task, to: HandOffTarget) -> ServiceResult<Vec<String>> {
        let projects = self.store.list_projects().map_err(|e| e.to_string())?;
        let paths: Vec<(String, PathBuf)> = projects
            .into_iter()
            .map(|project| (project.id, PathBuf::from(project.path)))
            .collect();
        let roots = blocking(move || {
            paths
                .into_iter()
                .filter_map(|(id, path)| aiwb_git::repository_root(&path).ok().map(|root| (id, root)))
                .collect::<std::collections::HashMap<_, _>>()
        })
        .await?;
        let same_repo = |other: &Task| match (&task.project_id, &other.project_id) {
            (Some(mine), Some(theirs)) => mine == theirs || (roots.contains_key(mine) && roots.get(mine) == roots.get(theirs)),
            _ => false,
        };
        let tasks: Vec<Task> = self
            .store
            .list_tasks()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|other| other.id == task.id || same_repo(other))
            .collect();
        let sessions = self.store.list_sessions().map_err(|e| e.to_string())?;
        let busy = |task_id: &str| sessions.iter().any(|session| session.task_id == task_id && session_busy(session));
        if busy(&task.id) {
            return Err("任务还在运行，等它停下再交接".into());
        }
        let in_project = |other: &Task| {
            other.id != task.id
                && matches!(
                    other.workspace,
                    TaskWorkspace::Root | TaskWorkspace::Worktree { local: Some(_), .. }
                )
        };
        if to == HandOffTarget::Local {
            if let Some(other) = tasks.iter().find(|other| {
                other.id != task.id
                    && matches!(other.workspace, TaskWorkspace::Worktree { local: Some(_), .. })
            }) {
                return Err(format!("「{}」已经交给了项目目录，先把它交回工作树", other.title));
            }
        }
        if let Some(other) = tasks.iter().find(|other| in_project(other) && busy(&other.id)) {
            return Err(format!("项目目录里的「{}」还在运行，等它停下再交接", other.title));
        }
        Ok(tasks
            .iter()
            .filter(|other| in_project(other))
            .map(|other| other.id.clone())
            .collect())
    }
}
