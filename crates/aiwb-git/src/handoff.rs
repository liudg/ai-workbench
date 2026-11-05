//! 照 Codex 桌面版的 Hand off（learn.chatgpt.com/docs/environments/git-worktrees
//! 「Option 2: Handing a chat off to Local」）：把任务的分支和改动在工作树与项目目录之间挪动。
//! 一个分支同一时间只能检出在一处，所以先让出来再检出。Codex 没写具体做法，以下是我们的设计：
//! 未提交的改动用临时 index 写成提交带过去（不碰 index 和 stash），对面铺回成未提交的状态。
//! 被忽略的文件不跟着走。项目目录有未提交的改动时拒绝，不替用户收起。

use std::path::Path;

use aiwb_core::task::LocalHandoff;

use crate::branch::status_paths;
use crate::snapshot::changes_commit;
use crate::worktree::{
    branch_name, git_failure, git_output, git_status, git_stdout, head_sha, repository_root, user_git_status,
};

/// 列文件时最多写几个。
const FILES_SHOWN: usize = 5;

/// 交接途中的改动挂在这里，出错时不会变成没人指着的提交；成功后删掉。
const HANDOFF_REF_PREFIX: &str = "refs/aiwb/handoff/";

/// 把工作树的分支和改动挪到项目目录。工作树没有分支时用 `new_branch` 在工作树里先建一个。
/// 成功后工作树停在分离头指针，项目目录检出这个分支。
pub fn hand_off_to_local(
    project: &Path,
    worktree: &Path,
    new_branch: Option<&str>,
) -> Result<LocalHandoff, String> {
    let local = repository_root(project)?;
    let tree_root = repository_root(worktree)?;
    require_clean(&local, "项目目录")?;
    let (branch, created) = match branch_name(&tree_root)? {
        Some(branch) => (branch, false),
        None => {
            let name = new_branch
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| "工作树还没有分支，先起一个分支名".to_string())?;
            git_status(&tree_root, &["check-ref-format", "--branch", name])
                .map_err(|_| format!("分支名不合法：{name}"))?;
            user_git_status(&tree_root, &["switch", "-q", "-c", name])?;
            (name.to_string(), true)
        }
    };
    let moved = move_to_local(&local, &tree_root, &branch);
    if moved.is_err() && created {
        // 这次为交接建的分支撤掉，工作树回到没有分支的样子。分支上还没有新提交。
        let _ = user_git_status(&tree_root, &["switch", "-q", "--detach"]);
        let _ = git_status(&tree_root, &["branch", "-q", "-D", &branch]);
    }
    let (previous_branch, previous_head) = moved?;
    Ok(LocalHandoff {
        branch,
        previous_branch,
        previous_head,
    })
}

/// 工作树已经在 `branch` 上：把分支和改动挪到项目目录，返回项目目录原来的分支和提交。出错时两边放回原样。
fn move_to_local(local: &Path, tree_root: &Path, branch: &str) -> Result<(Option<String>, String), String> {
    let previous_branch = branch_name(local)?;
    let previous_head = head_sha(local)?;
    let changes = Pending::capture(tree_root, local)?;
    let tip = head_sha(tree_root)?;
    user_git_status(tree_root, &["switch", "-q", "--detach"]).map_err(|err| changes.failed(err))?;
    let moved = user_git_status(local, &["switch", "-q", branch]).and_then(|()| changes.lay_down(local));
    if let Err(err) = moved {
        // 放回原样：项目目录回到原来的位置（交接前是干净的，铺上去的都清掉），工作树重新检出分支和改动。
        let _ = user_git_status(local, &["reset", "-q", "--hard"]);
        let _ = user_git_status(local, &["clean", "-q", "-fd"]);
        let _ = match &previous_branch {
            Some(name) => user_git_status(local, &["switch", "-q", name]),
            None => user_git_status(local, &["switch", "-q", "--detach", &previous_head]),
        };
        let _ = user_git_status(tree_root, &["switch", "-q", branch]);
        let _ = changes.lay_down(tree_root);
        return Err(changes.failed(err));
    }
    if changes.commit.is_some() {
        // 改动已经在项目目录里了，工作树留个干净的检出。
        let _ = user_git_status(tree_root, &["reset", "-q", "--hard", &tip]);
        let _ = user_git_status(tree_root, &["clean", "-q", "-fd"]);
    }
    changes.release(local);
    Ok((previous_branch, previous_head))
}

/// 把任务交回工作树。项目目录还在交接的分支上时，分支和改动一起挪回来，项目目录回到交接前所在的分支；
/// 项目目录已经离开这个分支（比如切回主分支去合并了），就不动项目目录，工作树检出这个分支接着做，
/// 分支删掉了就留在原来的提交上。
/// 项目目录没动时返回 `None`；切回去了时返回从项目目录带走的未提交文件（项目目录是共用的，
/// 期间别的任务在那里改的东西也会一起带走，调用方要告诉用户）。
pub fn hand_back_to_worktree(
    project: &Path,
    worktree: &Path,
    handoff: &LocalHandoff,
) -> Result<Option<Vec<String>>, String> {
    let local = repository_root(project)?;
    let tree_root = repository_root(worktree)?;
    require_clean(&tree_root, "工作树")?;
    if branch_name(&local)?.as_deref() != Some(handoff.branch.as_str()) {
        let spec = format!("refs/heads/{}", handoff.branch);
        if git_stdout(&local, &["rev-parse", "--verify", "--quiet", &spec]).is_ok() {
            user_git_status(&tree_root, &["switch", "-q", &handoff.branch])?;
        }
        return Ok(None);
    }
    let changes = Pending::capture(&local, &local)?;
    let tip = head_sha(&local)?;
    let restore_local = || {
        let _ = user_git_status(&local, &["switch", "-q", &handoff.branch]);
        let _ = changes.lay_down(&local);
    };
    // 先让项目目录离开这个分支，工作树才能检出它。中途失败（文件被占用）就把改动铺回项目目录。
    let back = user_git_status(&local, &["reset", "-q", "--hard", &tip])
        .and_then(|()| match changes.commit {
            Some(_) => user_git_status(&local, &["clean", "-q", "-fd"]),
            None => Ok(()),
        })
        .and_then(|()| match handoff.previous_branch.as_deref().filter(|name| *name != handoff.branch) {
            // 原来的分支删掉或改名了，就回到交接前那个提交上。
            Some(name) => user_git_status(&local, &["switch", "-q", name])
                .or_else(|_| user_git_status(&local, &["switch", "-q", "--detach", &handoff.previous_head])),
            None => user_git_status(&local, &["switch", "-q", "--detach", &handoff.previous_head]),
        });
    if let Err(err) = back {
        restore_local();
        return Err(changes.failed(err));
    }
    let moved = user_git_status(&tree_root, &["switch", "-q", &handoff.branch]).and_then(|()| changes.lay_down(&tree_root));
    if let Err(err) = moved {
        let _ = user_git_status(&tree_root, &["reset", "-q", "--hard"]);
        let _ = user_git_status(&tree_root, &["clean", "-q", "-fd"]);
        let _ = user_git_status(&tree_root, &["switch", "-q", "--detach"]);
        restore_local();
        return Err(changes.failed(err));
    }
    changes.release(&local);
    Ok(Some(changes.files.clone()))
}

/// 交接途中带着走的改动：没提交的改动（含未跟踪、不含被忽略的文件）写成的提交，和挂着它的引用。
struct Pending {
    commit: Option<String>,
    reference: Option<String>,
    /// 改动涉及的文件，相对仓库根目录。
    files: Vec<String>,
}

impl Pending {
    /// 在 `root` 上写出改动，引用挂在 `repo`（同一个仓库）上。没有改动时为空。
    fn capture(root: &Path, repo: &Path) -> Result<Self, String> {
        let head = head_sha(root)?;
        let Some(commit) = changes_commit(root, &head)? else {
            return Ok(Self {
                commit: None,
                reference: None,
                files: Vec::new(),
            });
        };
        let names = git_stdout(root, &["-c", "core.quotePath=false", "diff", "--name-only", &head, &commit])
            .unwrap_or_default();
        let files = names.lines().map(str::to_string).filter(|name| !name.is_empty()).collect();
        let id = uuid::Uuid::new_v4().simple().to_string();
        let reference = format!("{HANDOFF_REF_PREFIX}{id}");
        git_status(repo, &["update-ref", &reference, &commit])?;
        Ok(Self {
            commit: Some(commit),
            reference: Some(reference),
            files,
        })
    }

    /// 把改动铺到检出上，index 回到 HEAD，改动成为未提交的状态。
    fn lay_down(&self, root: &Path) -> Result<(), String> {
        let Some(commit) = &self.commit else {
            return Ok(());
        };
        user_git_status(root, &["read-tree", "-u", "--reset", commit])?;
        user_git_status(root, &["reset", "-q"])
    }

    /// 出错时引用留着，错误里写上去哪找回改动。
    fn failed(&self, err: String) -> String {
        match &self.reference {
            Some(reference) => format!("{err}（没提交的改动存在 {reference}）"),
            None => err,
        }
    }

    fn release(&self, repo: &Path) {
        if let Some(reference) = &self.reference {
            let _ = git_status(repo, &["update-ref", "-d", reference]);
        }
    }
}

fn require_clean(root: &Path, place: &str) -> Result<(), String> {
    let output = git_output(root, &["status", "--porcelain=v1", "-z", "--untracked-files=normal"])?;
    if !output.status.success() {
        return Err(git_failure(&output, "无法读取改动"));
    }
    let files = status_paths(&output.stdout);
    if files.is_empty() {
        return Ok(());
    }
    Err(format!("{place}有未提交的改动：{}。先提交或收起再交接", list_files(&files)))
}

/// 列几个文件名，多了写总数。
pub fn list_files(files: &[String]) -> String {
    let mut shown = files.iter().take(FILES_SHOWN).cloned().collect::<Vec<_>>().join("、");
    if files.len() > FILES_SHOWN {
        shown.push_str(&format!(" 等 {} 个文件", files.len()));
    }
    shown
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::{create_task_worktree, remove_checkout, NewWorktree};
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    fn run_git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git").args(args).current_dir(cwd).status().expect("git");
        assert!(status.success(), "{args:?}");
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-workbench-handoff-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn repo(name: &str) -> PathBuf {
        let root = scratch(name);
        run_git(&root, &["init", "-q", "-b", "main"]);
        run_git(&root, &["config", "user.email", "t@t"]);
        run_git(&root, &["config", "user.name", "t"]);
        run_git(&root, &["config", "core.autocrlf", "false"]);
        fs::write(root.join(".gitignore"), "build/\n").unwrap();
        fs::write(root.join("app.txt"), "v1\n").unwrap();
        run_git(&root, &["add", "."]);
        run_git(&root, &["-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
        root
    }

    #[test]
    fn work_moves_to_the_project_and_back() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let project = repo("roundtrip");
        let managed = scratch("roundtrip-managed");
        let made = create_task_worktree(&project, &managed, &NewWorktree::default()).unwrap();
        run_git(&made.cwd, &["config", "user.email", "t@t"]);
        run_git(&made.cwd, &["config", "user.name", "t"]);
        fs::write(made.cwd.join("app.txt"), "v2\n").unwrap();
        fs::write(made.cwd.join("new.txt"), "new\n").unwrap();
        fs::create_dir_all(made.cwd.join("build")).unwrap();
        fs::write(made.cwd.join("build/out"), "x").unwrap();

        assert!(hand_off_to_local(&project, &made.cwd, None).is_err(), "没有分支名时要先起名");
        let handoff = hand_off_to_local(&project, &made.cwd, Some("aiwb/feature")).unwrap();
        assert_eq!(handoff.branch, "aiwb/feature");
        assert_eq!(handoff.previous_branch.as_deref(), Some("main"));
        assert_eq!(branch_name(&project).unwrap().as_deref(), Some("aiwb/feature"));
        assert_eq!(branch_name(&made.cwd).unwrap(), None);
        assert_eq!(fs::read_to_string(project.join("app.txt")).unwrap(), "v2\n");
        assert_eq!(fs::read_to_string(project.join("new.txt")).unwrap(), "new\n");
        assert!(!project.join("build").exists(), "被忽略的文件不跟着走");
        assert_eq!(fs::read_to_string(made.cwd.join("app.txt")).unwrap(), "v1\n");
        assert!(!made.cwd.join("new.txt").exists());

        // 在项目目录里接着改、提交一次，再交回去。
        fs::write(project.join("app.txt"), "v3\n").unwrap();
        run_git(&project, &["-c", "commit.gpgsign=false", "commit", "-qam", "v3"]);
        fs::write(project.join("more.txt"), "more\n").unwrap();
        let moved = hand_back_to_worktree(&project, &made.cwd, &handoff).unwrap().unwrap();
        assert_eq!(moved, vec!["more.txt".to_string(), "new.txt".to_string()]);
        assert_eq!(branch_name(&project).unwrap().as_deref(), Some("main"));
        assert_eq!(fs::read_to_string(project.join("app.txt")).unwrap(), "v1\n");
        assert!(!project.join("more.txt").exists());
        assert!(!project.join("new.txt").exists());
        assert_eq!(branch_name(&made.cwd).unwrap().as_deref(), Some("aiwb/feature"));
        assert_eq!(fs::read_to_string(made.cwd.join("app.txt")).unwrap(), "v3\n");
        assert_eq!(fs::read_to_string(made.cwd.join("new.txt")).unwrap(), "new\n");
        assert_eq!(fs::read_to_string(made.cwd.join("more.txt")).unwrap(), "more\n");

        remove_checkout(&project, &made.root);
        let _ = fs::remove_dir_all(managed);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn a_dirty_project_is_refused_and_a_moved_project_still_hands_back() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let project = repo("refuse");
        let managed = scratch("refuse-managed");
        let made = create_task_worktree(&project, &managed, &NewWorktree::default()).unwrap();
        run_git(&made.cwd, &["switch", "-q", "-c", "aiwb/x"]);
        fs::write(made.cwd.join("app.txt"), "wt\n").unwrap();
        fs::write(project.join("app.txt"), "local\n").unwrap();
        let err = hand_off_to_local(&project, &made.cwd, None).unwrap_err();
        assert!(err.contains("app.txt"), "{err}");
        assert_eq!(branch_name(&made.cwd).unwrap().as_deref(), Some("aiwb/x"));
        assert_eq!(fs::read_to_string(made.cwd.join("app.txt")).unwrap(), "wt\n");
        assert_eq!(fs::read_to_string(project.join("app.txt")).unwrap(), "local\n");

        run_git(&project, &["checkout", "-q", "--", "app.txt"]);
        let handoff = hand_off_to_local(&project, &made.cwd, None).unwrap();
        // 项目目录切回 main 去合并了：交回时不动项目目录，工作树检出原分支接着做。
        run_git(&project, &["add", "app.txt"]);
        run_git(&project, &["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "wt"]);
        run_git(&project, &["switch", "-q", "main"]);
        assert_eq!(hand_back_to_worktree(&project, &made.cwd, &handoff).unwrap(), None);
        assert_eq!(branch_name(&project).unwrap().as_deref(), Some("main"));
        assert_eq!(branch_name(&made.cwd).unwrap().as_deref(), Some("aiwb/x"));
        assert_eq!(fs::read_to_string(made.cwd.join("app.txt")).unwrap(), "wt\n");

        // 分支删掉了也能交回，工作树留在原来的提交上。
        let again = hand_off_to_local(&project, &made.cwd, None).unwrap();
        run_git(&project, &["switch", "-q", "main"]);
        run_git(&project, &["branch", "-q", "-D", "aiwb/x"]);
        assert_eq!(hand_back_to_worktree(&project, &made.cwd, &again).unwrap(), None);
        assert_eq!(branch_name(&made.cwd).unwrap(), None);
        assert!(git_stdout(&project, &["for-each-ref", "refs/aiwb/handoff"]).is_err(), "交接用的引用都删掉了");

        remove_checkout(&project, &made.root);
        let _ = fs::remove_dir_all(managed);
        let _ = fs::remove_dir_all(project);
    }
}
