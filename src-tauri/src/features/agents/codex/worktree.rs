//! 斜杠 `/worktree` 和 `/worktree new`。
//! 根目录读 `codex-worktrees.json`；没有这份文件时用 Codex 主目录下的 worktrees。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::encoding::{apply_utf8_env, decode_child_bytes};
use crate::features::agents::AgentError;
use crate::models::strip_verbatim_prefix;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct WorktreeInfo {
    pub path: String,
    pub head: String,
    pub branch: String,
    pub detached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct WorktreeSettings {
    pub root: String,
    /// 官方默认保留最近 15 个 Codex 管理的工作树。
    pub keep: u32,
    pub auto_prune: bool,
    pub worktrees: Vec<WorktreeInfo>,
}

use super::process::hide_console;

const DEFAULT_KEEP: u32 = 15;

#[derive(Debug, Clone, Deserialize)]
struct Prefs {
    root: String,
    keep: u32,
    auto_prune: bool,
}

async fn settings_for(project_path: Option<&str>) -> Result<WorktreeSettings, AgentError> {
    let prefs = load_prefs();
    let worktrees = match project_path.map(str::trim).filter(|path| !path.is_empty()) {
        Some(path) => list_worktrees(path).await?,
        None => Vec::new(),
    };
    Ok(WorktreeSettings {
        root: prefs.root,
        keep: prefs.keep,
        auto_prune: prefs.auto_prune,
        worktrees,
    })
}

pub async fn create_worktree(project_path: &str) -> Result<WorktreeInfo, AgentError> {
    let project_path = project_path.trim();
    if project_path.is_empty() {
        return Err(AgentError::Runtime("先选择一个 Git 仓库".into()));
    }
    if !is_git_repo(project_path).await? {
        return Err(AgentError::Runtime(
            "工作树只适用于 Git 仓库。".into(),
        ));
    }
    let prefs = load_prefs();
    let repo_name = Path::new(project_path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("repo");
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "worktree".into());
    let dest = PathBuf::from(&prefs.root).join(repo_name).join(&id);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            AgentError::Runtime(format!("无法创建工作树根目录：{err}"))
        })?;
    }
    let output = git(project_path, &["worktree", "add", "--detach", &dest.to_string_lossy()]).await?;
    if !output.status.success() {
        return Err(AgentError::Runtime(format!(
            "无法创建工作树：{}",
            decode_child_bytes(&output.stderr).trim()
        )));
    }
    Ok(WorktreeInfo {
        path: dest.to_string_lossy().to_string(),
        head: String::new(),
        branch: String::new(),
        detached: true,
    })
}

pub async fn render_worktrees(project_path: &str) -> Result<String, AgentError> {
    let settings = settings_for(Some(project_path)).await?;
    let mut lines = vec![
        format!("工作树根目录：{}", settings.root),
        format!(
            "保留最近 {} 个。{}",
            settings.keep,
            if settings.auto_prune {
                "清理时把超出的工作树移到回收站。"
            } else {
                "已关闭自动清理。"
            }
        ),
    ];
    if settings.worktrees.is_empty() {
        lines.push("这个仓库还没有工作树。用法：/worktree new".into());
    } else {
        for tree in &settings.worktrees {
            let place = if tree.detached {
                "detached HEAD".to_string()
            } else if tree.branch.is_empty() {
                tree.head.clone()
            } else {
                tree.branch.clone()
            };
            lines.push(format!("{}  {place}", tree.path));
        }
    }
    Ok(lines.join("\n"))
}

async fn list_worktrees(project_path: &str) -> Result<Vec<WorktreeInfo>, AgentError> {
    if !Path::new(project_path).exists() {
        return Ok(Vec::new());
    }
    let output = git(project_path, &["worktree", "list", "--porcelain"]).await?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    Ok(parse_worktree_list(&decode_child_bytes(&output.stdout)))
}

async fn is_git_repo(project_path: &str) -> Result<bool, AgentError> {
    let output = git(project_path, &["rev-parse", "--is-inside-work-tree"]).await?;
    Ok(output.status.success())
}

async fn git(cwd: &str, args: &[&str]) -> Result<std::process::Output, AgentError> {
    let mut command = Command::new("git");
    command
        .args(["-c", "core.quotepath=false", "-C", cwd])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_utf8_env(&mut command);
    hide_console(&mut command);
    command
        .output()
        .await
        .map_err(|err| AgentError::Runtime(format!("无法运行 git：{err}")))
}

pub(super) fn parse_worktree_list(text: &str) -> Vec<WorktreeInfo> {
    let mut listed = Vec::new();
    let mut current: Option<WorktreeInfo> = None;
    for line in text.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(item) = current.take() {
                listed.push(item);
            }
            current = Some(WorktreeInfo {
                path: strip_verbatim_prefix(path.trim()),
                head: String::new(),
                branch: String::new(),
                detached: false,
            });
        } else if let Some(item) = current.as_mut() {
            if let Some(head) = line.strip_prefix("HEAD ") {
                item.head = head.trim().to_string();
            } else if let Some(branch) = line.strip_prefix("branch ") {
                item.branch = branch
                    .trim()
                    .trim_start_matches("refs/heads/")
                    .to_string();
            } else if line.trim() == "detached" {
                item.detached = true;
            }
        }
    }
    if let Some(item) = current {
        listed.push(item);
    }
    listed
}

fn load_prefs() -> Prefs {
    let path = prefs_path();
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(prefs) = serde_json::from_str::<Prefs>(&raw) {
            if !prefs.root.trim().is_empty() {
                return prefs;
            }
        }
    }
    Prefs {
        root: default_root().to_string_lossy().to_string(),
        keep: DEFAULT_KEEP,
        auto_prune: true,
    }
}

fn prefs_path() -> PathBuf {
    data_dir().join("codex-worktrees.json")
}

fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("AI_WORKBENCH_DATA_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        return PathBuf::from(appdata).join("com.aiworkbench.app");
    }
    PathBuf::from(".").join("com.aiworkbench.app")
}

pub(super) fn default_root() -> PathBuf {
    codex_home().join("worktrees")
}

fn codex_home() -> PathBuf {
    if let Ok(home) = std::env::var("CODEX_HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home);
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        return PathBuf::from(profile).join(".codex");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".codex");
    }
    PathBuf::from(".codex")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_detached_worktree() {
        let listed = parse_worktree_list(
            "worktree C:/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree \\\\?\\C:/wt\nHEAD def\ndetached\n",
        );
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].branch, "main");
        assert!(!listed[0].detached);
        assert_eq!(listed[1].path, "C:/wt");
        assert!(listed[1].detached);
    }

    #[test]
    fn default_keep_matches_desktop() {
        assert_eq!(DEFAULT_KEEP, 15);
    }
}
