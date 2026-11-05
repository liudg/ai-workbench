//! 新工作树里补上被忽略的本地文件，照 Codex 桌面版的 `.worktreeinclude`
//! （learn.chatgpt.com/docs/environments/git-worktrees「Copying ignored files」）：
//! 仓库根目录的 `.worktreeinclude` 按 `.gitignore` 的写法列出要复制的路径；
//! 只复制本来就被忽略的文件，不复制符号链接，不覆盖已有文件；
//! 被忽略的 `AGENTS.override.md` 不用列也会带上。

use std::fs;
use std::path::Path;

use crate::worktree::git_output;

const INCLUDE_FILE: &str = ".worktreeinclude";
const ALWAYS: &str = "AGENTS.override.md";
const CHECK_BATCH: usize = 100;

/// 从主检出复制到新工作树。出错的文件跳过，不让建工作树失败。
pub(crate) fn copy_included(repo: &Path, root: &Path) {
    for relative in included_files(repo) {
        let from = repo.join(&relative);
        let to = root.join(&relative);
        let Ok(meta) = fs::symlink_metadata(&from) else {
            continue;
        };
        // 目标上已有东西（包括坏掉的符号链接）就不覆盖。
        if !meta.file_type().is_file() || fs::symlink_metadata(&to).is_ok() {
            continue;
        }
        if let Some(parent) = to.parent() {
            if fs::create_dir_all(parent).is_err() {
                continue;
            }
        }
        let _ = fs::copy(&from, &to);
    }
}

/// 没被跟踪、被 `.gitignore` 忽略、又被 `.worktreeinclude` 选中的文件，相对仓库根目录。
fn included_files(repo: &Path) -> Vec<String> {
    let mut picked = Vec::new();
    let include = repo.join(INCLUDE_FILE);
    if include.is_file() {
        let include = include.to_string_lossy().into_owned();
        let exclude_from = format!("--exclude-from={include}");
        picked = list(repo, &["ls-files", "-z", "--others", "--ignored", &exclude_from]);
    }
    if repo.join(ALWAYS).is_file() {
        picked.push(ALWAYS.to_string());
    }
    if picked.is_empty() {
        return picked;
    }
    // 成批问哪些被 .gitignore 忽略，每批路径不多，免得命令行超长。
    let mut ignored = Vec::new();
    for chunk in picked.chunks(CHECK_BATCH) {
        // -z 只能配 --stdin，这里按行读；quotePath 关掉，中文路径原样输出。
        let mut args = vec!["-c", "core.quotePath=false", "check-ignore", "--no-index", "--"];
        args.extend(chunk.iter().map(String::as_str));
        ignored.extend(lines(repo, &args));
    }
    ignored.sort();
    ignored.dedup();
    ignored
}

fn list(repo: &Path, args: &[&str]) -> Vec<String> {
    let Ok(output) = git_output(repo, args) else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    aiwb_proc::decode_child_bytes(&output.stdout)
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect()
}

fn lines(repo: &Path, args: &[&str]) -> Vec<String> {
    let Ok(output) = git_output(repo, args) else {
        return Vec::new();
    };
    aiwb_proc::decode_child_bytes(&output.stdout)
        .lines()
        .map(str::trim_end)
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::{create_task_worktree, remove_checkout, NewWorktree};
    use std::path::PathBuf;
    use std::process::Command;

    fn run_git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git").args(args).current_dir(cwd).status().expect("git");
        assert!(status.success(), "{args:?}");
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-workbench-include-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_ignored_files_named_in_worktreeinclude_are_copied() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let repo = scratch("repo");
        run_git(&repo, &["init", "-q", "-b", "main"]);
        fs::write(repo.join(".gitignore"), ".env\nconfig/secret.json\nnode_modules/\nAGENTS.override.md\nlocal.txt\n").unwrap();
        fs::write(repo.join(".worktreeinclude"), "# 本地密钥\n.env\nconfig/*.json\ntracked.txt\n").unwrap();
        fs::write(repo.join("tracked.txt"), "tracked\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(
            &repo,
            &["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"],
        );
        fs::write(repo.join(".env"), "KEY=1\n").unwrap();
        fs::create_dir_all(repo.join("config")).unwrap();
        fs::write(repo.join("config/secret.json"), "{}").unwrap();
        fs::create_dir_all(repo.join("node_modules/x")).unwrap();
        fs::write(repo.join("node_modules/x/index.js"), "").unwrap();
        fs::write(repo.join("AGENTS.override.md"), "local rules\n").unwrap();
        fs::write(repo.join("local.txt"), "not listed\n").unwrap();
        fs::write(repo.join("tracked.txt"), "edited in main\n").unwrap();

        let managed = scratch("managed");
        let made = create_task_worktree(&repo, &managed, &NewWorktree::default()).unwrap();
        assert_eq!(fs::read_to_string(made.cwd.join(".env")).unwrap(), "KEY=1\n");
        assert!(made.cwd.join("config/secret.json").is_file());
        assert!(made.cwd.join("AGENTS.override.md").is_file());
        assert!(!made.cwd.join("node_modules").exists());
        assert!(!made.cwd.join("local.txt").exists());
        assert_eq!(
            fs::read_to_string(made.cwd.join("tracked.txt")).unwrap().replace("\r\n", "\n"),
            "tracked\n",
            "跟踪的文件不按 .worktreeinclude 复制"
        );
        remove_checkout(&repo, &made.root);
        let _ = fs::remove_dir_all(managed);
        let _ = fs::remove_dir_all(repo);
    }
}
