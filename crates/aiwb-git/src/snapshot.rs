//! 工作树清理前存快照，之后按快照在原路径上恢复。
//!
//! 照 Codex 桌面版：删掉托管工作树前先存一份，打开任务时能恢复
//! （learn.chatgpt.com/docs/environments/git-worktrees「Worktree cleanup」）。
//! Codex 没写快照的做法，这里用临时 index 把整个工作树写成一个提交，挂在
//! `refs/aiwb/snapshots/<名字>` 下，不碰用户的 index 和分支。被忽略的文件不进快照。

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use aiwb_core::task::WorktreeSnapshot;

use crate::worktree::{
    git_output, git_status, git_status_env, git_stdout, git_stdout_env, head_sha, linked_checkout,
    read_marker, record_owned_worktree, remove_worktree_tree, repository_root, same_path, OwnedMarker,
};

const SNAPSHOT_REF_PREFIX: &str = "refs/aiwb/snapshots/";

/// 清理的第一步：把工作树存成快照，挂上引用，不动目录。
/// 不是工作台的工作树时什么都不动，返回 `None`。调用方把快照记进任务以后，再 `remove_shelved_worktree`。
pub fn snapshot_worktree(project: &Path, cwd: &Path, name: &str) -> Result<Option<WorktreeSnapshot>, String> {
    let name = snapshot_name(name)?;
    let Some(checkout) = linked_checkout(project, cwd)? else {
        return Ok(None);
    };
    if read_marker(&checkout.cwd).filter(|item| same_path(&item.root, &checkout.root)).is_none() {
        return Ok(None);
    }
    let head = head_sha(&checkout.root)?;
    let commit = snapshot_commit(&checkout.root, &head)?;
    let reference = format!("{SNAPSHOT_REF_PREFIX}{name}");
    git_status(project, &["update-ref", &reference, &commit])?;
    Ok(Some(WorktreeSnapshot {
        reference,
        head,
        branch: checkout.branch.clone(),
        root: checkout.root.to_string_lossy().into_owned(),
    }))
}

/// 清理的第二步：删掉存过快照的工作树。不删任何分支，也不硬摘登记。
/// git 删不掉（工作树还在用，比如被编辑器打开、文件被占用）就报错，登记和剩下的文件都留着；
/// 登记摘掉了就把残留的目录也清掉，删不干净的在恢复时再清。
pub fn remove_shelved_worktree(project: &Path, root: &Path) -> Result<(), String> {
    let root_arg = root.to_string_lossy().into_owned();
    let removed = git_status(project, &["worktree", "remove", "--force", &root_arg]);
    if registered(project, root) {
        return Err(removed.err().unwrap_or_else(|| "工作树还在用，这次不清".into()));
    }
    remove_worktree_tree(root);
    if !root.exists() {
        if let Ok(repo) = repository_root(project) {
            crate::worktree::remove_empty_worktree_containers(root, &repo);
        }
    }
    Ok(())
}

/// 在原路径上重建工作树，把快照里的改动铺回去（未提交的状态）。
/// 快照引用留给调用方在记下“已恢复”之后再删（`drop_snapshot`），中途出错时还能再恢复。
/// 原来的分支还在且指着原提交就切回去；分支没了就按原名重建；被别处占着就留在分离头指针。
/// 原路径上还是一份登记着的完整工作树（清理记了快照、还没删掉就停了，或者删的时候还在用），
/// 就直接接着用它：里面的东西不比快照旧。
pub fn restore_worktree(
    project: &Path,
    snapshot: &WorktreeSnapshot,
    base: Option<&str>,
    base_sha: &str,
) -> Result<(), String> {
    let root = PathBuf::from(&snapshot.root);
    let root_arg = root.to_string_lossy().into_owned();
    let marker = OwnedMarker {
        root: root.clone(),
        base: base.map(str::to_string),
        sha: base_sha.to_string(),
        // 分支是用户在工作树里建的，不记进来：删工作树时只删记录里的分支。
        branch: None,
    };
    if registered(project, &root) {
        if root.join(".git").exists() {
            if read_marker(&root).is_none() {
                record_owned_worktree(&root, &marker)?;
            }
            return Ok(());
        }
        // 只摘这一份的旧登记，不动别的工作树（`worktree prune` 会把暂时不在的也摘掉）。
        unregister_missing(project, &root);
    }
    if root.exists() {
        // 清理时没删干净的残留（Windows 上文件被占着）。改动都在快照里，残留可以丢。
        remove_worktree_tree(&root);
        if root.exists() {
            return Err("工作树原来的目录还有文件被占用，关掉占用它的程序后再试".into());
        }
    }
    if let Some(parent) = root.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("无法创建工作树目录: {err}"))?;
    }
    add_checkout(project, &root_arg, snapshot)?;
    let applied = git_status(&root, &["read-tree", "-u", "--reset", &snapshot.reference])
        .and_then(|()| git_status(&root, &["reset", "-q"]))
        .and_then(|()| record_owned_worktree(&root, &marker));
    if let Err(err) = applied {
        let _ = git_status(project, &["worktree", "remove", "--force", &root_arg]);
        return Err(err);
    }
    if let Ok(repo) = repository_root(project) {
        crate::include::copy_included(&repo, &root);
    }
    Ok(())
}

/// `git worktree list` 里有没有这个路径。
fn registered(project: &Path, root: &Path) -> bool {
    let Ok(output) = git_output(project, &["worktree", "list", "--porcelain", "-z"]) else {
        return false;
    };
    aiwb_proc::decode_child_bytes(&output.stdout)
        .split('\0')
        .filter_map(|field| field.strip_prefix("worktree "))
        .any(|path| same_path(Path::new(path), root) || paths_equal(path, root))
}

/// 路径不在了时 `same_path` 规范化不了，按文本比（不分大小写和斜杠方向）。
fn paths_equal(text: &str, root: &Path) -> bool {
    let norm = |value: &str| value.replace('\\', "/").trim_end_matches('/').to_lowercase();
    norm(text) == norm(&root.to_string_lossy())
}

/// 目录已经不在、登记还在的那一份：删掉它在 `.git/worktrees/` 下的管理目录。
fn unregister_missing(project: &Path, root: &Path) {
    let Ok(common) = git_stdout(project, &["rev-parse", "--path-format=absolute", "--git-common-dir"]) else {
        return;
    };
    let Ok(entries) = fs::read_dir(Path::new(&common).join("worktrees")) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(gitdir) = fs::read_to_string(entry.path().join("gitdir")) else {
            continue;
        };
        let pointed = gitdir.trim();
        let checkout = pointed.strip_suffix("/.git").or_else(|| pointed.strip_suffix("\\.git")).unwrap_or(pointed);
        if paths_equal(checkout, root) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// 任务删掉以后，它的快照也不用留着。
pub fn drop_snapshot(project: &Path, reference: &str) {
    if reference.starts_with(SNAPSHOT_REF_PREFIX) {
        let _ = git_status(project, &["update-ref", "-d", reference]);
    }
}

fn add_checkout(project: &Path, root: &str, snapshot: &WorktreeSnapshot) -> Result<(), String> {
    if let Some(branch) = snapshot.branch.as_deref() {
        let spec = format!("refs/heads/{branch}");
        match git_stdout(project, &["rev-parse", "--verify", "--quiet", &spec]) {
            Ok(tip) if tip == snapshot.head => {
                if git_status(project, &["worktree", "add", root, branch]).is_ok() {
                    return Ok(());
                }
            }
            Ok(_) => {}
            Err(_) => {
                if git_status(project, &["worktree", "add", "-b", branch, root, &snapshot.head]).is_ok() {
                    return Ok(());
                }
            }
        }
    }
    git_status(project, &["worktree", "add", "--detach", root, &snapshot.head])
}

/// 用临时 index 写出整个工作树（遵守 `.gitignore`），父提交是现在的 HEAD。
/// 每次用自己的临时 index，同一仓库上同时存几份也不会互相覆盖。
pub(crate) fn snapshot_commit(root: &Path, head: &str) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let index = crate::worktree::owned_git_file(root, &format!("aiwb-snapshot-{id}.index"))?;
    let _ = fs::remove_file(&index);
    let index_env = [("GIT_INDEX_FILE", index.as_os_str())];
    // 从检出自己的 index 拷一份开始：带着文件的时间戳缓存，`add -A` 不用把每个文件重新算一遍。
    let real = crate::worktree::owned_git_file(root, "index").ok().filter(|path| path.is_file());
    let seeded = real.is_some_and(|real| fs::copy(&real, &index).is_ok());
    let result = (|| {
        if !seeded {
            git_status_env(root, &["read-tree", head], &index_env)?;
        }
        git_status_env(root, &["add", "-A", "--", "."], &index_env)?;
        let tree = git_stdout_env(root, &["write-tree"], &index_env)?;
        let who = [
            ("GIT_AUTHOR_NAME", OsStr::new("AI Workbench")),
            ("GIT_AUTHOR_EMAIL", OsStr::new("aiwb@localhost")),
            ("GIT_COMMITTER_NAME", OsStr::new("AI Workbench")),
            ("GIT_COMMITTER_EMAIL", OsStr::new("aiwb@localhost")),
        ];
        git_stdout_env(
            root,
            &["commit-tree", &tree, "-p", head, "-m", "AI Workbench 工作树快照"],
            &who,
        )
    })();
    let _ = fs::remove_file(&index);
    result.map_err(|err| format!("无法保存工作树快照：{err}"))
}

/// `root` 上没提交的改动写成的提交。没有改动时为空。
pub(crate) fn changes_commit(root: &Path, head: &str) -> Result<Option<String>, String> {
    let commit = snapshot_commit(root, head)?;
    let tree = git_stdout(root, &["rev-parse", &format!("{commit}^{{tree}}")])?;
    let head_tree = git_stdout(root, &["rev-parse", &format!("{head}^{{tree}}")])?;
    Ok((tree != head_tree).then_some(commit))
}

fn snapshot_name(name: &str) -> Result<&str, String> {
    let ok = !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if ok {
        Ok(name)
    } else {
        Err("快照名不合法".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::{branch_name, create_task_worktree, session_worktree, NewWorktree};
    use std::process::{Command, Stdio};

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-workbench-snap-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git_ok() -> bool {
        Command::new("git")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .status()
            .expect("git");
        assert!(status.success(), "{args:?}");
    }

    fn repo_with_commit(name: &str) -> PathBuf {
        let root = scratch(name);
        run_git(&root, &["init", "-b", "main"]);
        run_git(&root, &["config", "user.email", "wt@example.com"]);
        run_git(&root, &["config", "user.name", "wt"]);
        // 和 git stash 一样，铺回来的文件按 autocrlf 转行尾。这里比字节，关掉它。
        run_git(&root, &["config", "core.autocrlf", "false"]);
        fs::write(root.join(".gitignore"), "target/\n.env\n").unwrap();
        fs::write(root.join(".worktreeinclude"), ".env\n").unwrap();
        fs::write(root.join("note.txt"), "one\n").unwrap();
        fs::write(root.join("gone.txt"), "bye\n").unwrap();
        run_git(&root, &["add", "."]);
        run_git(&root, &["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
        fs::write(root.join(".env"), "KEY=1\n").unwrap();
        root
    }

    /// 清理的两步连着做。
    fn shelve_worktree(repo: &Path, cwd: &Path, name: &str) -> Result<Option<WorktreeSnapshot>, String> {
        let snapshot = snapshot_worktree(repo, cwd, name)?;
        if let Some(snapshot) = &snapshot {
            remove_shelved_worktree(repo, Path::new(&snapshot.root))?;
        }
        Ok(snapshot)
    }

    fn status(cwd: &Path) -> String {
        let output = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(cwd)
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout).replace("\r\n", "\n")
    }

    #[test]
    fn shelved_worktree_comes_back_with_its_uncommitted_work() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("roundtrip");
        let managed = scratch("roundtrip-managed");
        let made = create_task_worktree(&repo, &managed, &NewWorktree::default()).unwrap();
        run_git(&made.cwd, &["config", "user.email", "wt@example.com"]);
        run_git(&made.cwd, &["config", "user.name", "wt"]);
        run_git(&made.cwd, &["switch", "-q", "-c", "aiwb/work"]);
        fs::write(made.cwd.join("committed.txt"), "c\n").unwrap();
        run_git(&made.cwd, &["add", "committed.txt"]);
        run_git(&made.cwd, &["-c", "commit.gpgsign=false", "commit", "-m", "work"]);
        fs::write(made.cwd.join("note.txt"), "two\n").unwrap();
        fs::write(made.cwd.join("fresh.txt"), "new\n").unwrap();
        fs::remove_file(made.cwd.join("gone.txt")).unwrap();
        fs::create_dir_all(made.cwd.join("target")).unwrap();
        fs::write(made.cwd.join("target/big.bin"), "ignored").unwrap();
        let before = status(&made.cwd);

        let snapshot = shelve_worktree(&repo, &made.cwd, "task-1").unwrap().unwrap();
        assert!(!made.root.exists());
        assert_eq!(snapshot.branch.as_deref(), Some("aiwb/work"));
        assert!(git_stdout(&repo, &["rev-parse", "--verify", &snapshot.reference]).is_ok());

        restore_worktree(&repo, &snapshot, made.base.as_deref(), &made.sha).unwrap();
        assert_eq!(fs::read_to_string(made.cwd.join("note.txt")).unwrap(), "two\n");
        assert_eq!(fs::read_to_string(made.cwd.join("fresh.txt")).unwrap(), "new\n");
        assert!(made.cwd.join("committed.txt").is_file());
        assert!(!made.cwd.join("gone.txt").exists());
        assert!(!made.cwd.join("target").exists(), "被忽略的文件不进快照");
        assert!(made.cwd.join(".env").is_file(), "按 .worktreeinclude 重新复制");
        assert_eq!(status(&made.cwd), before);
        assert_eq!(head_sha(&made.cwd).unwrap(), snapshot.head);
        assert_eq!(branch_name(&made.cwd).unwrap().as_deref(), Some("aiwb/work"));
        assert_eq!(crate::checked_out_branch(&made.cwd).as_deref(), Some("aiwb/work"));
        assert!(session_worktree(&repo, &made.cwd).unwrap().owned);
        assert!(
            git_stdout(&repo, &["rev-parse", "--verify", "--quiet", &snapshot.reference]).is_ok(),
            "恢复后由调用方记好状态再删快照"
        );
        drop_snapshot(&repo, &snapshot.reference);
        assert!(git_stdout(&repo, &["rev-parse", "--verify", "--quiet", &snapshot.reference]).is_err());

        crate::worktree::discard_confirmed_worktree(&repo, &made.cwd, true);
        assert!(
            git_stdout(&repo, &["rev-parse", "--verify", "--quiet", "refs/heads/aiwb/work"]).is_ok(),
            "删工作树不删用户建的分支"
        );
        let _ = fs::remove_dir_all(managed);
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn shelving_an_old_task_keeps_its_recorded_branch() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("legacy");
        let managed = scratch("legacy-managed");
        let root = managed.join("legacy-wt");
        run_git(&repo, &["worktree", "add", "-q", "-b", "aiwb/legacy", root.to_str().unwrap()]);
        let sha = head_sha(&root).unwrap();
        let root = crate::worktree::dunce_or_canonicalize(&root).unwrap();
        record_owned_worktree(
            &root,
            &OwnedMarker { root: root.clone(), base: Some("main".into()), sha, branch: Some("aiwb/legacy".into()) },
        )
        .unwrap();
        let snapshot = shelve_worktree(&repo, &root, "task-5").unwrap().unwrap();
        assert!(!root.exists());
        assert!(
            git_stdout(&repo, &["rev-parse", "--verify", "--quiet", "refs/heads/aiwb/legacy"]).is_ok(),
            "清理不删分支，上面可能有交接后提交的东西"
        );
        restore_worktree(&repo, &snapshot, Some("main"), &snapshot.head).unwrap();
        assert_eq!(branch_name(&root).unwrap().as_deref(), Some("aiwb/legacy"));
        crate::worktree::remove_checkout(&repo, &root);
        let _ = fs::remove_dir_all(managed);
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn restore_keeps_a_checkout_that_is_still_registered() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("still-there");
        let managed = scratch("still-there-managed");
        let made = create_task_worktree(&repo, &managed, &NewWorktree::default()).unwrap();
        fs::write(made.cwd.join("editing.txt"), "open in an editor").unwrap();
        let snapshot = WorktreeSnapshot {
            reference: "refs/aiwb/snapshots/task-x".into(),
            head: made.sha.clone(),
            branch: None,
            root: made.root.to_string_lossy().into_owned(),
        };
        restore_worktree(&repo, &snapshot, None, &made.sha).unwrap();
        assert!(made.cwd.join("editing.txt").is_file(), "还在用的完整工作树直接接着用，不能被恢复清掉");
        crate::worktree::remove_checkout(&repo, &made.root);
        let _ = fs::remove_dir_all(managed);
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn a_missing_registration_is_cleared_without_touching_other_worktrees() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("unregister");
        let managed = scratch("unregister-managed");
        let made = create_task_worktree(&repo, &managed, &NewWorktree::default()).unwrap();
        let other = create_task_worktree(&repo, &managed, &NewWorktree::default()).unwrap();
        let snapshot = shelve_worktree(&repo, &made.cwd, "task-u").unwrap().unwrap();
        // 另一份暂时不在（比如盘没插上），恢复时不能把它的登记也摘掉。
        let parked = managed.join("parked");
        fs::rename(&other.root, &parked).unwrap();
        restore_worktree(&repo, &snapshot, None, &made.sha).unwrap();
        assert!(registered(&repo, &other.root), "别的工作树的登记还在");
        fs::rename(&parked, &other.root).unwrap();
        crate::worktree::remove_checkout(&repo, &made.root);
        crate::worktree::remove_checkout(&repo, &other.root);
        let _ = fs::remove_dir_all(managed);
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn a_worktree_still_in_use_is_not_removed() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("in-use");
        let managed = scratch("in-use-managed");
        let made = create_task_worktree(&repo, &managed, &NewWorktree::default()).unwrap();
        fs::write(made.cwd.join("open.txt"), "x").unwrap();
        run_git(&repo, &["worktree", "lock", made.root.to_str().unwrap()]);
        let snapshot = snapshot_worktree(&repo, &made.cwd, "task-l").unwrap().unwrap();
        assert!(remove_shelved_worktree(&repo, Path::new(&snapshot.root)).is_err());
        assert!(made.cwd.join("open.txt").is_file(), "删不掉就整个留着");
        assert!(registered(&repo, &made.root));
        run_git(&repo, &["worktree", "unlock", made.root.to_str().unwrap()]);
        crate::worktree::remove_checkout(&repo, &made.root);
        let _ = fs::remove_dir_all(managed);
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn restore_stays_detached_when_the_branch_moved_on() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("moved");
        let managed = scratch("moved-managed");
        let made = create_task_worktree(&repo, &managed, &NewWorktree::default()).unwrap();
        run_git(&made.cwd, &["switch", "-q", "-c", "aiwb/moved"]);
        let snapshot = shelve_worktree(&repo, &made.cwd, "task-2").unwrap().unwrap();
        assert_eq!(snapshot.branch.as_deref(), Some("aiwb/moved"));
        fs::write(repo.join("note.txt"), "main moved\n").unwrap();
        run_git(&repo, &["-c", "commit.gpgsign=false", "commit", "-am", "move"]);
        run_git(&repo, &["branch", "-f", "aiwb/moved", "HEAD"]);

        restore_worktree(&repo, &snapshot, made.base.as_deref(), &made.sha).unwrap();
        assert_eq!(head_sha(&made.cwd).unwrap(), snapshot.head);
        assert_eq!(branch_name(&made.cwd).unwrap(), None);

        crate::worktree::remove_checkout(&repo, &made.root);
        let _ = fs::remove_dir_all(managed);
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn unrecorded_worktree_is_left_alone() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("foreign");
        let manual = scratch("foreign-wt");
        let _ = fs::remove_dir(&manual);
        run_git(&repo, &["worktree", "add", "--detach", manual.to_str().unwrap()]);
        assert_eq!(shelve_worktree(&repo, &manual, "task-3").unwrap(), None);
        assert!(manual.join("note.txt").is_file());
        assert!(shelve_worktree(&repo, &manual, "../bad").is_err());
        run_git(&repo, &["worktree", "remove", "--force", manual.to_str().unwrap()]);
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn leftovers_from_a_partial_cleanup_are_cleared_on_restore() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("occupied");
        let managed = scratch("occupied-managed");
        let made = create_task_worktree(&repo, &managed, &NewWorktree::default()).unwrap();
        let snapshot = shelve_worktree(&repo, &made.cwd, "task-4").unwrap().unwrap();
        fs::create_dir_all(&made.root).unwrap();
        fs::write(made.root.join("leftover.bin"), "x").unwrap();
        restore_worktree(&repo, &snapshot, None, &made.sha).unwrap();
        assert!(!made.root.join("leftover.bin").exists());
        assert!(made.cwd.join("note.txt").is_file());
        crate::worktree::remove_checkout(&repo, &made.root);
        let _ = fs::remove_dir_all(managed);
        let _ = fs::remove_dir_all(repo);
    }
}
