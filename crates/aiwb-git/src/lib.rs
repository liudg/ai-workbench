//! 本地分支的读取、切换和创建。工作树差异在 `diff`。

mod branch;
mod diff;
mod handoff;
mod include;
mod snapshot;
mod worktree;

pub use diff::git_diff_text;
pub use handoff::{hand_back_to_worktree, hand_off_to_local, list_files};
pub use snapshot::{drop_snapshot, remove_shelved_worktree, restore_worktree, snapshot_worktree};

pub use branch::{
    checkout_local_branch, create_and_checkout_branch, local_branch_menu, GitBranchMenu,
};
pub use worktree::{
    bind_codex_thread, create_task_worktree, delete_preview, discard_confirmed_worktree,
    is_owned_worktree, repo_has_commit, repository_root, DeletePreview, NewWorktree, TaskWorktree,
};

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// 检出现在所在的分支。直接读 HEAD 文件，不起 git 进程，列任务时每个工作树读一次也不慢。
/// `cwd` 可以在检出的子目录里。目录不在、分离头指针或读不出时为空。
pub fn checked_out_branch(cwd: &Path) -> Option<String> {
    let checkout = cwd.ancestors().find(|dir| dir.join(".git").exists())?;
    let dot_git = checkout.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        // 工作树的 `.git` 是一个文件：`gitdir: <管理目录>`。
        let text = std::fs::read_to_string(&dot_git).ok()?;
        let dir = PathBuf::from(text.trim().strip_prefix("gitdir:")?.trim());
        checkout.join(dir)
    };
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    head.trim().strip_prefix("ref: refs/heads/").map(str::to_string)
}

/// 当前分支名。不是仓库、分离头指针或空输出时返回 `None`。
/// `git branch --show-current` 在分离头指针时成功但没有名字。
pub fn current_branch(root: &Path) -> Result<Option<String>, String> {
    if !root.is_dir() {
        return Err("项目不存在".into());
    }
    let mut command = Command::new("git");
    command
        .args([
            "-c",
            "safe.bareRepository=explicit",
            "branch",
            "--show-current",
        ])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0");
    aiwb_proc::apply_utf8_env_std(&mut command);
    hide_console(&mut command);
    let output = command
        .output()
        .map_err(|err| format!("无法运行 git: {err}"))?;
    if output.status.success() {
        let name = aiwb_proc::decode_child_bytes(&output.stdout);
        let name = name.trim();
        if name.is_empty() || name == "HEAD" {
            return Ok(None);
        }
        return Ok(Some(name.to_string()));
    }
    let stderr = aiwb_proc::decode_child_bytes(&output.stderr);
    let stderr = stderr.trim();
    if stderr.contains("not a git repository") {
        return Ok(None);
    }
    if stderr.is_empty() {
        return Err("无法读取当前分支".into());
    }
    Err(stderr.to_string())
}

/// 项目目录是不是 git 工作区。
/// 与 Codex `get_git_diff` 相同：`git rev-parse --is-inside-work-tree`。
pub fn inside_work_tree(root: &Path) -> Result<bool, String> {
    if !root.is_dir() {
        return Err("项目不存在".into());
    }
    let mut command = Command::new("git");
    command
        .args([
            "-c",
            "safe.bareRepository=explicit",
            "rev-parse",
            "--is-inside-work-tree",
        ])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0");
    aiwb_proc::apply_utf8_env_std(&mut command);
    hide_console(&mut command);
    let output = command
        .output()
        .map_err(|err| format!("无法运行 git: {err}"))?;
    if output.status.success() {
        let stdout = aiwb_proc::decode_child_bytes(&output.stdout);
        return Ok(stdout.trim() == "true");
    }
    let stderr = aiwb_proc::decode_child_bytes(&output.stderr);
    let stderr = stderr.trim();
    if stderr.contains("not a git repository") {
        return Ok(false);
    }
    if stderr.is_empty() {
        return Err("无法确认是否为 git 仓库".into());
    }
    Err(stderr.to_string())
}

/// 在新建的项目目录里 `git init`。
pub fn init_repository(root: &Path) -> Result<(), String> {
    let output = git_output(root, &["init"])?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = aiwb_proc::decode_child_bytes(&output.stderr);
    Err(format!("git init 失败: {}", stderr.trim()))
}

pub(crate) fn git_output(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    if !root.is_dir() {
        return Err("项目不存在".into());
    }
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0");
    aiwb_proc::apply_utf8_env_std(&mut command);
    hide_console(&mut command);
    command
        .output()
        .map_err(|err| format!("无法运行 git: {err}"))
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let _ = command;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ai-workbench-git-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn run_git(cwd: &Path, args: &[&str]) -> bool {
        let mut command = Command::new("git");
        command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console(&mut command);
        command
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[test]
    fn inside_work_tree_follows_rev_parse() {
        let mut probe = Command::new("git");
        probe
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console(&mut probe);
        if !probe
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return;
        }
        let root = scratch("work-tree");
        assert_eq!(inside_work_tree(&root).unwrap(), false);
        assert!(run_git(&root, &["init"]));
        assert_eq!(inside_work_tree(&root).unwrap(), true);
        let branch = current_branch(&root).unwrap();
        assert!(
            branch.as_deref().is_some_and(|name| !name.is_empty()),
            "{branch:?}"
        );
        let _ = fs::remove_dir_all(root);
        let plain = scratch("not-git");
        assert_eq!(current_branch(&plain).unwrap(), None);
        let _ = fs::remove_dir_all(plain);
    }
}
