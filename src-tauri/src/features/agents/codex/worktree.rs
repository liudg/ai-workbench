//! 工作树。桌面端在设置 → Worktrees 里改根目录和保留数量，
//! 新对话在 composer 下选择 Worktree。这里提供同一套根目录、列表和创建。
//! 删除只进回收站，不用 `git worktree remove --force`。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::encoding::{apply_utf8_env, decode_child_bytes};
use crate::features::agents::AgentError;
use crate::models::{strip_verbatim_prefix, WorktreeInfo, WorktreeSettings};

use super::process::hide_console;

const DEFAULT_KEEP: u32 = 15;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Prefs {
    root: String,
    keep: u32,
    auto_prune: bool,
}

pub async fn settings_for(project_path: Option<&str>) -> Result<WorktreeSettings, AgentError> {
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

pub fn save_settings(root: &str, keep: u32, auto_prune: bool) -> Result<WorktreeSettings, AgentError> {
    let root = root.trim();
    if root.is_empty() {
        return Err(AgentError::Runtime("填写工作树根目录".into()));
    }
    let keep = keep.clamp(1, 100);
    let prefs = Prefs {
        root: root.to_string(),
        keep,
        auto_prune,
    };
    write_prefs(&prefs)?;
    Ok(WorktreeSettings {
        root: prefs.root,
        keep: prefs.keep,
        auto_prune: prefs.auto_prune,
        worktrees: Vec::new(),
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

pub async fn recycle_worktree(project_path: &str, worktree_path: &str) -> Result<(), AgentError> {
    let worktree_path = worktree_path.trim();
    let project_path = project_path.trim();
    if worktree_path.is_empty() {
        return Err(AgentError::Runtime("缺少工作树路径".into()));
    }
    let prefs = load_prefs();
    let root = PathBuf::from(&prefs.root);
    let target = PathBuf::from(worktree_path);
    if !target.starts_with(&root) {
        return Err(AgentError::Runtime(
            "只能把工作树根目录里的 Codex 工作树移到回收站。".into(),
        ));
    }
    recycle_directory(&target)?;
    if !project_path.is_empty() {
        let _ = git(project_path, &["worktree", "prune"]).await;
    }
    Ok(())
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

fn write_prefs(prefs: &Prefs) -> Result<(), AgentError> {
    let path = prefs_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| AgentError::Runtime(format!("无法保存工作树设置：{err}")))?;
    }
    let raw = serde_json::to_string_pretty(prefs)
        .map_err(|err| AgentError::Runtime(err.to_string()))?;
    fs::write(path, raw).map_err(|err| AgentError::Runtime(format!("无法保存工作树设置：{err}")))
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

fn recycle_directory(path: &Path) -> Result<(), AgentError> {
    if !path.exists() {
        return Err(AgentError::Runtime("工作树目录已经不在了".into()));
    }
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("powershell");
        command
            .args([
                "-NoProfile",
                "-Command",
                "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:AI_WORKBENCH_RECYCLE, 'OnlyErrorDialogs', 'SendToRecycleBin')",
            ])
            .env("AI_WORKBENCH_RECYCLE", path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let output = command
            .output()
            .map_err(|err| AgentError::Runtime(format!("无法移到回收站：{err}")))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(AgentError::Runtime(format!(
                "无法移到回收站：{}",
                err.trim()
            )));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(AgentError::Runtime(
            "只把工作树送进回收站；当前系统没有回收站。".into(),
        ))
    }
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
