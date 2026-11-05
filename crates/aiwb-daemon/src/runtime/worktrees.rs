//! 清理掉的工作树在用到时恢复。会话启动前和用户点「恢复」都走这里。

use std::path::{Path, PathBuf};

use aiwb_core::task::{Task, TaskEntry, TaskWorkspace};

use super::{RuntimeResult, Runtimes};

/// 工作树任务现在的分支。看板、子任务回报都按这一条算。
pub(crate) fn task_branch(task: &Task) -> Option<String> {
    match &task.workspace {
        TaskWorkspace::Worktree { local: Some(local), .. } => Some(local.branch.clone()),
        TaskWorkspace::Worktree { shelved: Some(snapshot), .. } => snapshot.branch.clone(),
        TaskWorkspace::Worktree { path, .. } => aiwb_git::checked_out_branch(Path::new(path)),
        _ => None,
    }
}

impl Runtimes {
    /// 发给界面的任务列表，带上每个工作树任务现在的分支。
    pub(crate) fn task_entries(&self) -> RuntimeResult<Vec<TaskEntry>> {
        let mut entries = self.store.task_entries().map_err(|e| e.to_string())?;
        for entry in &mut entries {
            entry.branch = task_branch(&entry.task);
        }
        Ok(entries)
    }

    /// 任务的工作树被清理过就按快照放回原路径。共用同一工作树的分叉任务一起改回来。
    /// 没清理过时什么都不做。会话启动前、用户点「恢复」、交回工作树前都走这里。
    /// 先拿锁再读任务：正在清理的会等清理写完标记。
    /// 返回这次有没有真的恢复。
    pub(crate) async fn restore_worktree(&self, task_id: &str) -> RuntimeResult<bool> {
        let _lock = self.worktrees.lock().await;
        self.restore_worktree_locked(task_id).await
    }

    /// 调用方已经拿着 `worktrees` 锁。
    pub(crate) async fn restore_worktree_locked(&self, task_id: &str) -> RuntimeResult<bool> {
        let store_err = |e: aiwb_store::StoreError| e.to_string();
        let task = self
            .store
            .task(task_id)
            .map_err(store_err)?
            .ok_or_else(|| "任务不存在".to_string())?;
        let TaskWorkspace::Worktree {
            path,
            base_ref,
            base_sha,
            shelved: Some(snapshot),
            ..
        } = task.workspace
        else {
            return Ok(false);
        };
        let project_id = task.project_id.ok_or_else(|| "项目不存在".to_string())?;
        let project = self
            .store
            .project(&project_id)
            .map_err(store_err)?
            .ok_or_else(|| "项目不存在".to_string())?;
        let restored = snapshot.clone();
        let project_path = PathBuf::from(project.path);
        let target = project_path.clone();
        tokio::task::spawn_blocking(move || {
            aiwb_git::restore_worktree(
                &target,
                &restored,
                base_ref.as_deref(),
                &base_sha,
            )
        })
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| format!("工作树恢复失败：{err}"))?;
        for mut other in self.store.list_tasks().map_err(store_err)? {
            if let TaskWorkspace::Worktree {
                path: other_path,
                shelved,
                ..
            } = &mut other.workspace
            {
                if *other_path == path && shelved.as_ref() == Some(&snapshot) {
                    *shelved = None;
                    self.store
                        .set_task_workspace(&other.id, &other.workspace)
                        .map_err(store_err)?;
                    // 刚恢复的算最近用过，不然下一轮清理又把它清掉。
                    self.store
                        .touch_task(&other.id, aiwb_core::models::now_millis())
                        .map_err(store_err)?;
                }
            }
        }
        // 记好“已恢复”之后再删快照：中途出错时任务还标着已清理，快照也还在，能再恢复一次。
        let reference = snapshot.reference.clone();
        let project = project_path.clone();
        let _ = tokio::task::spawn_blocking(move || aiwb_git::drop_snapshot(&project, &reference)).await;
        self.publish_tasks()?;
        Ok(true)
    }
}
