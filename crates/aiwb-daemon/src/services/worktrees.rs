//! 工作树的保留和清理，照 Codex 桌面版（docs/worktree-lifecycle.md）。
//!
//! 只算工作台自己建的工作树，所有项目合起来最多留 `keep_count` 个，按最后活动时间从旧的清。
//! 置顶、正在跑或等输入、父任务还在跑、还有分叉任务共用的不清。任务全归档了的工作树直接清。清之前存快照，下次用到时在原路径恢复。
//! 设置项和默认值照 `openai/codex` 的 `codex-rs/worktree/src/settings.rs`。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use aiwb_core::task::{TaskEntry, TaskWorkspace};
use serde::{Deserialize, Serialize};

use super::projects::normalize_dir;
use super::{blocking, session_busy, ServiceResult, Services};

const ROOT_KEY: &str = "worktree.root";
const AUTO_CLEANUP_KEY: &str = "worktree.autoCleanup";
const KEEP_COUNT_KEY: &str = "worktree.keepCount";

/// Codex 的 `DEFAULT_WORKTREE_KEEP_COUNT`。
pub(crate) const DEFAULT_KEEP_COUNT: usize = 15;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeSettings {
    root: String,
    default_root: String,
    auto_cleanup: bool,
    keep_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetWorktreeSettings {
    /// 空串表示回到默认目录。
    #[serde(default)]
    root: Option<String>,
    #[serde(default)]
    auto_cleanup: Option<bool>,
    #[serde(default)]
    keep_count: Option<usize>,
}

#[derive(Deserialize)]
pub(crate) struct RestoreWorktree {
    id: String,
}

/// 一个工作树目录和用着它的任务（分叉出来的任务共用目录）。
struct Group {
    project: PathBuf,
    cwd: String,
    tasks: Vec<String>,
    /// 在工作树里干活的任务（交给了项目目录的不算）和它们的会话。清理前要停掉。
    users: Vec<String>,
    sessions: Vec<String>,
    protected: bool,
    /// 用着它的任务都归档了。
    archived: bool,
    /// 用着它、没归档的任务数。
    live: usize,
    active_at: i64,
}

impl Services {
    pub(crate) fn worktree_settings(&self) -> ServiceResult<WorktreeSettings> {
        let meta = |key| self.store.meta(key).map_err(|e| e.to_string());
        Ok(WorktreeSettings {
            root: self.worktree_root()?.to_string_lossy().into_owned(),
            default_root: self.worktree_root.to_string_lossy().into_owned(),
            auto_cleanup: meta(AUTO_CLEANUP_KEY)?.as_deref() != Some("false"),
            keep_count: meta(KEEP_COUNT_KEY)?
                .and_then(|raw| raw.parse::<usize>().ok())
                .filter(|count| *count > 0)
                .unwrap_or(DEFAULT_KEEP_COUNT),
        })
    }

    pub(crate) async fn set_worktree_settings(
        &self,
        params: SetWorktreeSettings,
    ) -> ServiceResult<WorktreeSettings> {
        let set = |key, value: &str| self.store.set_meta(key, value).map_err(|e| e.to_string());
        if params.keep_count == Some(0) {
            return Err("至少保留 1 个工作树".into());
        }
        if let Some(root) = params.root {
            let root = root.trim();
            if root.is_empty() {
                set(ROOT_KEY, "")?;
            } else {
                let dir = normalize_dir(root)?;
                if !dir.is_absolute() {
                    return Err("工作树目录必须是绝对路径".into());
                }
                // 放在项目里，新工作树会成为项目检出里没跟踪的文件。
                let inside = self
                    .store
                    .list_projects()
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .find(|project| path_within(&dir, std::path::Path::new(&project.path)));
                if let Some(project) = inside {
                    return Err(format!("工作树目录不能放在项目「{}」里面", project.name));
                }
                set(ROOT_KEY, &dir.to_string_lossy())?;
            }
        }
        if let Some(auto_cleanup) = params.auto_cleanup {
            set(AUTO_CLEANUP_KEY, if auto_cleanup { "true" } else { "false" })?;
        }
        if let Some(count) = params.keep_count {
            set(KEEP_COUNT_KEY, &count.to_string())?;
        }
        self.request_worktree_sweep();
        self.worktree_settings()
    }

    /// 新工作树放在这里。改了目录只影响以后新建的。
    pub(crate) fn worktree_root(&self) -> ServiceResult<PathBuf> {
        let custom = self.store.meta(ROOT_KEY).map_err(|e| e.to_string())?;
        Ok(custom
            .filter(|path| !path.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.worktree_root.clone()))
    }

    pub(crate) async fn restore_task_worktree(&self, params: RestoreWorktree) -> ServiceResult<()> {
        if !self.runtimes.restore_worktree(&params.id).await? {
            return Ok(());
        }
        // 打开会话时没推目标（工作树还不在），恢复后接上 Agent 推一次。
        let sessions = self.store.task_sessions(&params.id).map_err(|e| e.to_string())?;
        if let Some(session) = sessions.last() {
            let handle = self.runtimes.handle(&session.id).await?;
            let _ = handle.publish_goal().await;
        }
        Ok(())
    }

    /// 后台清理：启动时跑一次，之后每次被叫醒（新建工作树、归档、改设置）再跑。
    pub(crate) fn start_worktree_sweeper(self: &Arc<Self>) {
        let services = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                services.sweep_worktrees().await;
                services.worktree_sweep.notified().await;
            }
        });
    }

    /// 叫醒后台清理。连着叫几次只跑一遍。
    pub(crate) fn request_worktree_sweep(&self) {
        self.worktree_sweep.notify_one();
    }

    /// 归档任务的工作树和超出上限的旧工作树，存快照后清掉。关了自动清理时不动。出错只记日志。
    pub async fn sweep_worktrees(&self) {
        if let Err(err) = self.sweep_worktrees_inner().await {
            eprintln!("清理工作树失败：{err}");
        }
    }

    async fn sweep_worktrees_inner(&self) -> ServiceResult<()> {
        let settings = self.worktree_settings()?;
        if !settings.auto_cleanup {
            return Ok(());
        }
        // 先不拿锁挑出要清的，git 查询不挡着别的任务启动。真要清时再拿锁、重新核对一遍。
        let mut groups = self.worktree_groups()?;
        groups.sort_by_key(|group| std::cmp::Reverse(group.active_at));
        let mut kept = 0;
        let mut doomed = Vec::new();
        for group in groups {
            let project = group.project.clone();
            let cwd = PathBuf::from(&group.cwd);
            let owned = blocking(move || aiwb_git::is_owned_worktree(&project, &cwd)).await?;
            if !owned {
                continue;
            }
            // 用着它的任务全归档了就清，不占名额。
            let keep = group.protected || (!group.archived && kept < settings.keep_count);
            if keep {
                kept += 1;
                continue;
            }
            doomed.push((group.cwd, group.archived, group.active_at));
        }
        for (cwd, archived, active_at) in doomed {
            let _lock = self.runtimes.worktrees.lock().await;
            let Some(group) = self.worktree_groups()?.into_iter().find(|group| group.cwd == cwd) else {
                continue;
            };
            // 挑出来以后有人用过、取消了归档、置顶了或者跑起来了，这一轮就不清它。
            if group.protected || group.archived != archived || group.active_at > active_at {
                continue;
            }
            if let Err(err) = self.shelve_group(group).await {
                eprintln!("清理工作树失败：{err}");
            }
        }
        Ok(())
    }

    /// 用户确认连工作树一起删任务时，没有别的任务再指着的快照引用一起删。
    pub(crate) async fn drop_task_snapshot(&self, task_id: &str) -> ServiceResult<()> {
        let Some(task) = self.store.task(task_id).map_err(|e| e.to_string())? else {
            return Ok(());
        };
        let TaskWorkspace::Worktree {
            path,
            shelved: Some(snapshot),
            ..
        } = task.workspace
        else {
            return Ok(());
        };
        // 共用工作树的任务一起清理，共用同一份快照。
        if self.worktree_shared(task_id, &path, false)? {
            return Ok(());
        }
        let Some(project) = self.project_path(task.project_id.as_deref())? else {
            return Ok(());
        };
        blocking(move || aiwb_git::drop_snapshot(&project, &snapshot.reference)).await?;
        Ok(())
    }

    /// 存快照，先把共用这个目录的任务都标成已清理，再删目录。删不掉（还在用）就撤回标记和快照。
    /// 中途停掉也不怕：目录还在、任务标着已清理时，恢复会直接接着用这份目录。
    async fn shelve_group(&self, group: Group) -> ServiceResult<()> {
        for task_id in &group.users {
            self.stop_task_sessions(task_id).await?;
        }
        self.terminals.close_owned(&group.sessions);
        let name = group.tasks[0].clone();
        let project = group.project.clone();
        let cwd = PathBuf::from(&group.cwd);
        let Some(snapshot) =
            blocking(move || aiwb_git::snapshot_worktree(&project, &cwd, &name)).await??
        else {
            return Ok(());
        };
        self.mark_shelved(&group.tasks, Some(&snapshot))?;
        let project = group.project.clone();
        let root = PathBuf::from(&snapshot.root);
        let removed = blocking(move || aiwb_git::remove_shelved_worktree(&project, &root)).await?;
        if let Err(err) = removed {
            self.mark_shelved(&group.tasks, None)?;
            let project = group.project.clone();
            let reference = snapshot.reference.clone();
            blocking(move || aiwb_git::drop_snapshot(&project, &reference)).await?;
            self.runtimes.publish_tasks()?;
            return Err(err);
        }
        self.runtimes.publish_tasks()
    }

    fn mark_shelved(
        &self,
        tasks: &[String],
        snapshot: Option<&aiwb_core::task::WorktreeSnapshot>,
    ) -> ServiceResult<()> {
        for task_id in tasks {
            let Some(mut task) = self.store.task(task_id).map_err(|e| e.to_string())? else {
                continue;
            };
            if let TaskWorkspace::Worktree { shelved, .. } = &mut task.workspace {
                *shelved = snapshot.cloned();
                self.store
                    .set_task_workspace(task_id, &task.workspace)
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    /// 还在磁盘上的工作树，按目录合并用着它的任务。
    fn worktree_groups(&self) -> ServiceResult<Vec<Group>> {
        let entries = self.store.task_entries().map_err(|e| e.to_string())?;
        let busy_of = |entry: &TaskEntry| entry.sessions.iter().chain(entry.sides.iter()).any(session_busy);
        // 父任务还在跑的子任务，父任务可能还要看它工作树里的改动。
        let busy_tasks: HashSet<&str> = entries
            .iter()
            .filter(|entry| busy_of(entry))
            .map(|entry| entry.task.id.as_str())
            .collect();
        let parents: HashMap<&str, &str> = entries
            .iter()
            .filter_map(|entry| Some((entry.task.id.as_str(), entry.task.parent_task_id.as_deref()?)))
            .collect();
        let mut groups: HashMap<String, Group> = HashMap::new();
        for entry in &entries {
            let TaskWorkspace::Worktree {
                path,
                shelved: None,
                local,
                ..
            } = &entry.task.workspace
            else {
                continue;
            };
            if !Path::new(path).is_dir() {
                continue;
            }
            let Some(project) = self.project_path(entry.task.project_id.as_deref())? else {
                continue;
            };
            let busy = busy_of(entry);
            let ancestor_busy = aiwb_core::task::ancestors(&parents, &entry.task.id).any(|id| busy_tasks.contains(id));
            let active_at = entry
                .sessions
                .iter()
                .map(|session| session.updated_at)
                .chain([entry.task.updated_at, entry.task.created_at])
                .max()
                .unwrap_or_default();
            let group = groups.entry(path.clone()).or_insert_with(|| Group {
                project,
                cwd: path.clone(),
                tasks: Vec::new(),
                users: Vec::new(),
                sessions: Vec::new(),
                protected: false,
                archived: true,
                live: 0,
                active_at,
            });
            group.tasks.push(entry.task.id.clone());
            if local.is_none() {
                group.users.push(entry.task.id.clone());
                group
                    .sessions
                    .extend(entry.sessions.iter().map(|session| session.id.clone()));
            }
            // 交给了项目目录的任务在别处跑，不拦着清理工作树。
            group.protected |= entry.task.pinned || ancestor_busy || (busy && local.is_none());
            group.archived &= entry.task.archived_at.is_some();
            group.active_at = group.active_at.max(active_at);
            group.live += usize::from(entry.task.archived_at.is_none());
        }
        // 还有几个没归档的分叉任务共用的工作树不清。
        Ok(groups
            .into_values()
            .map(|mut group| {
                group.protected |= group.live > 1;
                group
            })
            .collect())
    }
}

/// `dir` 是不是 `parent` 本身或在它下面。不分大小写和斜杠方向（Windows）。
fn path_within(dir: &Path, parent: &Path) -> bool {
    let norm = |path: &Path| {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        aiwb_core::models::strip_verbatim_prefix(&canonical.to_string_lossy())
            .replace(std::path::MAIN_SEPARATOR, "/")
            .trim_end_matches('/')
            .to_lowercase()
    };
    let (dir, parent) = (norm(dir), norm(parent));
    dir == parent || dir.starts_with(&format!("{parent}/"))
}
