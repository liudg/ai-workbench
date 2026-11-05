//! 任务用的 Git 工作树：任务层统一创建，Agent 只拿到 cwd；删除任务时按记录清掉目录和分支。
//!
//! 这些 git 命令关掉钩子和 fsmonitor，单条有时限，卡住时能返回。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 单条 git 的上限。钩子或 fsmonitor 卡住时要能返回，而不是一直占着启动。
const GIT_COMMAND_LIMIT: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkout {
    /// 会话要使用的工作目录。源目录在仓库子目录里时，保留相对位置。
    pub cwd: PathBuf,
    /// `git worktree remove` 用的检出根。
    pub root: PathBuf,
    /// 有名字才是分支。分离头指针时是 `None`。
    pub branch: Option<String>,
}

#[cfg(test)]
thread_local! {
    static AFTER_WORKTREE_GIT_REMOVE: std::cell::Cell<fn(&Path)> =
        const { std::cell::Cell::new(noop_after_worktree_remove) };
    static SKIP_GIT_WORKTREE_REMOVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static PREPARE_WORKTREE_DIR_REMOVE: std::cell::Cell<fn(&Path, u32)> =
        const { std::cell::Cell::new(noop_prepare_worktree_dir_remove) };
    static FAIL_REMOVE_DIR_ALL_TIMES: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn noop_after_worktree_remove(_root: &Path) {}

#[cfg(test)]
fn noop_prepare_worktree_dir_remove(_path: &Path, _attempt: u32) {}

fn kill_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    let mut command = if cfg!(windows) {
        let mut command = Command::new("taskkill");
        command.args(["/F", "/T", "/PID", &pid.to_string()]);
        command
    } else {
        let mut command = Command::new("kill");
        command.args(["-9", &pid.to_string()]);
        command
    };
    let _ = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

pub fn repo_has_commit(root: &Path) -> Result<bool, String> {
    if !root.is_dir() {
        return Ok(false);
    }
    let output = git_output(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            "HEAD^{commit}",
        ],
    )?;
    if output.status.success() {
        return Ok(true);
    }
    let stderr = aiwb_proc::decode_child_bytes(&output.stderr);
    let stderr = stderr.trim();
    if stderr.is_empty()
        || stderr.contains("not a git repository")
        || stderr.contains("Needed a single revision")
        || stderr.contains("unknown revision")
        || stderr.contains("ambiguous argument")
        || stderr.contains("bad revision")
    {
        return Ok(false);
    }
    Err(stderr.to_string())
}

pub fn repository_root(cwd: &Path) -> Result<PathBuf, String> {
    let output = git_output(cwd, &["rev-parse", "--show-toplevel"])?;
    if !output.status.success() {
        return Err(git_failure(&output, "找不到 Git 仓库"));
    }
    let text = aiwb_proc::decode_child_bytes(&output.stdout);
    let path = PathBuf::from(text.trim());
    dunce_or_canonicalize(&path)
}

/// 这个目录是不是 `project` 仓库里的链接工作树（不含主检出）。
pub fn linked_checkout(project: &Path, cwd: &Path) -> Result<Option<Checkout>, String> {
    if !project.is_dir() || !cwd.is_dir() {
        return Ok(None);
    }
    let Some(project_common) = git_path(project, "--git-common-dir")? else {
        return Ok(None);
    };
    let Some(cwd_common) = git_path(cwd, "--git-common-dir")? else {
        return Ok(None);
    };
    if project_common != cwd_common {
        return Ok(None);
    }
    let Some(git_dir) = git_path(cwd, "--git-dir")? else {
        return Ok(None);
    };
    if git_dir == cwd_common {
        return Ok(None);
    }
    let Some(root) = git_path(cwd, "--show-toplevel")? else {
        return Ok(None);
    };
    let branch = branch_name(cwd)?;
    let cwd = dunce_or_canonicalize(cwd)?;
    Ok(Some(Checkout { cwd, root, branch }))
}

/// 任务工作树的分支前缀。
const TASK_BRANCH_PREFIX: &str = "aiwb/";

/// 任务的工作树。任务层统一创建，Agent 只拿到 `cwd`。照 Codex 是分离头指针，要用时再建分支。
#[derive(Debug, Clone)]
pub struct TaskWorktree {
    pub cwd: PathBuf,
    pub root: PathBuf,
    /// 起点分支。从分离头指针的源目录建时为空。
    pub base: Option<String>,
    pub sha: String,
}

/// 新工作树从哪里开始。
#[derive(Debug, Clone, Default)]
pub struct NewWorktree {
    /// 起点分支。为空时用源目录现在的提交。
    pub base: Option<String>,
    /// 把源目录里没提交的改动一起带过去。只在起点就是源目录当前所在时有效。
    pub carry_changes: bool,
}

/// 照 Codex 桌面版：在 `managed_root/<仓库名>-<id>` 建一个分离头指针的工作树，
/// 按需带上源目录没提交的改动，再按 `.worktreeinclude` 复制被忽略的本地文件。
/// 源目录在仓库子目录里时，`cwd` 保留相对位置。失败时不留半成品。
pub fn create_task_worktree(
    source: &Path,
    managed_root: &Path,
    options: &NewWorktree,
) -> Result<TaskWorktree, String> {
    if !managed_root.is_absolute() {
        return Err("工作树目录必须是绝对路径".into());
    }
    let source = dunce_or_canonicalize(source)?;
    let repo = repository_root(&source)?;
    let repo_name = repo
        .file_name()
        .ok_or_else(|| "仓库没有目录名".to_string())?
        .to_string_lossy()
        .to_string();
    let (current, head) = source_revision(&source)?;
    let requested = options.base.as_deref().map(str::trim).filter(|name| !name.is_empty());
    // 只有起点就是源目录当前所在时才带改动（起点是别的分支时，哪怕提交相同也不带）。
    let (base, sha, on_current) = match requested {
        Some(name) if current.as_deref() != Some(name) => {
            let spec = format!("refs/heads/{name}^{{commit}}");
            let sha = git_stdout(&repo, &["rev-parse", "--verify", "--quiet", &spec])
                .map_err(|_| format!("找不到分支 {name}"))?;
            (Some(name.to_string()), sha, false)
        }
        _ => (current, head.clone(), true),
    };
    let carried = if options.carry_changes && on_current {
        crate::snapshot::changes_commit(&repo, &head)?
    } else {
        None
    };
    fs::create_dir_all(managed_root).map_err(|err| format!("无法创建工作树目录: {err}"))?;
    let id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
    let root = managed_root.join(format!("{repo_name}-{id}"));
    let root_arg = root.to_string_lossy().to_string();
    git_status(&repo, &["worktree", "add", "--detach", &root_arg, &sha])?;
    let undo = |err: String| {
        remove_checkout(&repo, &root);
        err
    };
    if let Some(commit) = &carried {
        git_status(&root, &["read-tree", "-u", "--reset", commit])
            .and_then(|()| git_status(&root, &["reset", "-q"]))
            .map_err(undo)?;
    }
    crate::include::copy_included(&repo, &root);
    let relative = relative_checkout(&repo, &source).map_err(undo)?;
    let cwd = root.join(&relative);
    if !cwd.is_dir() {
        return Err(undo("工作树里没有对应的工作目录".into()));
    }
    let cwd = dunce_or_canonicalize(&cwd).map_err(undo)?;
    let root = dunce_or_canonicalize(&root).map_err(undo)?;
    // 删除任务时靠这份记录认出是工作台建的工作树，才会连目录一起清掉。
    let marker = OwnedMarker {
        root: root.clone(),
        base: base.clone(),
        sha: sha.clone(),
        branch: None,
    };
    record_owned_worktree(&cwd, &marker).map_err(undo)?;
    Ok(TaskWorktree {
        cwd,
        root,
        base,
        sha,
    })
}

/// 创建失败时撤掉半成品。会话结束不调用。
/// Codex 官方在会话结束或删除时怎么清理工作树，本仓库资料里没有确认，标为未观察。
pub fn remove_checkout(source: &Path, checkout_root: &Path) {
    let root_arg = checkout_root.to_string_lossy().to_string();
    let _ = git_status(source, &["worktree", "remove", "--force", &root_arg]);
    if let Ok(repo) = repository_root(source) {
        let _ = git_status(&repo, &["worktree", "remove", "--force", &root_arg]);
    }
    remove_worktree_tree(checkout_root);
    if !checkout_root.exists() {
        let repo = repository_root(source).unwrap_or_else(|_| source.to_path_buf());
        remove_empty_worktree_containers(checkout_root, &repo);
    }
}

/// `codex-thread.json`，版本 1，字段 `ownerThreadId`。已有同一线程时保持原文件。
pub fn bind_codex_thread(cwd: &Path, thread_id: &str) -> Result<(), String> {
    let thread_id = thread_id.trim();
    if thread_id.is_empty() {
        return Err("没有线程 id".into());
    }
    let path = owned_git_file(cwd, "codex-thread.json")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("无法写入工作树记录: {err}"))?;
    }
    if path.is_file() {
        let existing = fs::read_to_string(&path).unwrap_or_default();
        if existing.contains(thread_id) {
            return Ok(());
        }
        return Err("这个工作树已经属于别的会话".into());
    }
    let body = serde_json::json!({
        "version": 1,
        "ownerThreadId": thread_id,
    });
    let mut file = fs::File::create(&path).map_err(|err| format!("无法写入工作树记录: {err}"))?;
    file.write_all(body.to_string().as_bytes())
        .map_err(|err| format!("无法写入工作树记录: {err}"))?;
    Ok(())
}

/// 工作台自己创建工作树时写下的记录。没有这份文件的检出不当作工作台的工作树。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedMarker {
    pub root: PathBuf,
    pub base: Option<String>,
    pub sha: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionWorktree {
    pub cwd: PathBuf,
    pub branch: Option<String>,
    pub base: Option<String>,
    pub sha: Option<String>,
    pub owned: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeletePreview {
    pub owned: bool,
    pub dirty: bool,
}

pub(crate) const MARKER_NAME: &str = "ai-workbench-worktree.json";

/// 源目录当时的分支和提交。分离头指针没有分支名。
pub fn source_revision(source: &Path) -> Result<(Option<String>, String), String> {
    let base = branch_name(source)?;
    let sha = git_stdout(
        source,
        &["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
    )?;
    Ok((base.filter(|name| name != "HEAD"), sha))
}

pub fn record_owned_worktree(cwd: &Path, marker: &OwnedMarker) -> Result<(), String> {
    if marker.sha.trim().len() < 7 {
        return Err("没有提交号".into());
    }
    let path = marker_path(cwd)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("无法记录工作树: {err}"))?;
    }
    let body = serde_json::json!({
        "version": 1,
        "base": marker.base.as_ref().map(|item| item.trim()).filter(|item| !item.is_empty()),
        "sha": marker.sha.trim(),
        "branch": marker.branch.as_ref().map(|item| item.trim()).filter(|item| !item.is_empty()),
        "root": marker.root.to_string_lossy(),
    });
    fs::write(&path, body.to_string()).map_err(|err| format!("无法记录工作树: {err}"))
}

/// 这个检出是不是本仓库的链接工作树，以及工作台有没有记录过它。
pub fn session_worktree(project: &Path, cwd: &Path) -> Option<SessionWorktree> {
    let checkout = linked_checkout(project, cwd).ok().flatten()?;
    let marker = read_marker(&checkout.cwd).filter(|item| same_path(&item.root, &checkout.root));
    let owned = marker.is_some() && !points_at_main(project, &checkout);
    let base = marker.as_ref().and_then(|item| item.base.clone());
    let sha = marker
        .as_ref()
        .map(|item| item.sha.clone())
        .or_else(|| head_sha(&checkout.cwd).ok());
    Some(SessionWorktree {
        cwd: checkout.cwd,
        branch: checkout.branch,
        base,
        sha,
        owned,
    })
}

/// 是不是工作台建的工作树。只读记录，不查改动，比 `delete_preview` 便宜。
pub fn is_owned_worktree(project: &Path, cwd: &Path) -> bool {
    session_worktree(project, cwd).is_some_and(|info| info.owned)
}

pub fn delete_preview(project: &Path, cwd: &Path) -> DeletePreview {
    let Some(info) = session_worktree(project, cwd) else {
        return DeletePreview {
            owned: false,
            dirty: false,
        };
    };
    if !info.owned {
        return DeletePreview {
            owned: false,
            dirty: false,
        };
    }
    let dirty = worktree_is_dirty(&info.cwd, info.base.as_deref(), project);
    DeletePreview { owned: true, dirty }
}

/// 只删除带记录、且不是主检出的链接工作树。`force` 用于用户确认过未保存改动。
/// 返回 false 表示这份目录不是工作台的工作树，什么都没动。
///
/// `force == false` 时不带 `--force`。git 若因未提交文件、状态检查失败或工作树锁而在摘登记之前退出，
/// 目录保持原样并返回错误。`force == true` 时先 `--force`，登记还在再 `--force --force`（锁定的工作树），
/// 然后尽量摘掉管理目录。登记没了就清磁盘和 `worktree-*` 分支。
/// git 常常先摘登记、删光文件，再在根目录上 `rmdir` 失败（Windows 句柄还没放开，或退出码已是 0）。
/// 这时目录是空的，要再删几次；仍然删不掉也不算失败。
pub fn remove_owned_worktree(project: &Path, cwd: &Path, force: bool) -> Result<bool, String> {
    let Some(checkout) = linked_checkout(project, cwd).ok().flatten() else {
        return Ok(false);
    };
    if points_at_main(project, &checkout) {
        return Ok(false);
    }
    let Some(marker) =
        read_marker(&checkout.cwd).filter(|item| same_path(&item.root, &checkout.root))
    else {
        return Ok(false);
    };
    // 删之前记下检出的提交：记录里的分支只有还指着它时才删，往前走过（交接后在项目目录里提交过）就留着。
    let head = head_sha(&checkout.root).ok();
    let root_arg = checkout.root.to_string_lossy().to_string();
    let mut git_error =
        git_worktree_remove(project, &checkout, &root_arg, if force { 1 } else { 0 });
    if force && checkout_still_registered(project, &checkout) {
        match git_worktree_remove(project, &checkout, &root_arg, 2) {
            None => git_error = None,
            Some(err) if git_error.is_none() => git_error = Some(err),
            Some(_) => {}
        }
    }
    after_worktree_git_remove(&checkout.root);
    if checkout_still_registered(project, &checkout) && force {
        best_effort_unregister(project, &checkout);
    }
    if checkout_still_registered(project, &checkout) {
        if force {
            discard_worktree_directory(project, &checkout, &marker.root);
            if !checkout.root.exists() {
                let _ = git_status(project, &["worktree", "prune"]);
            }
            if !checkout_still_registered(project, &checkout) {
                delete_recorded_branch(project, marker.branch.as_deref(), marker.base.as_deref(), head.as_deref());
                return Ok(true);
            }
        }
        return Err(git_error.unwrap_or_else(|| "工作树没有删掉".into()));
    }
    discard_worktree_directory(project, &checkout, &marker.root);
    if !checkout.root.exists() {
        let _ = git_status(project, &["worktree", "prune"]);
    }
    delete_recorded_branch(project, marker.branch.as_deref(), marker.base.as_deref(), head.as_deref());
    Ok(true)
}

/// 用户已经确认删除这份会话上的自建工作树。
/// 干净预览传来的 `force` 是 false：先让 git 自己拒绝未提交改动；这一步失败再强制删。
/// 一起删除传来的 `force` 是 true，直接强制。登记最后仍在也正常返回，调用方继续删会话。
/// 主检出和没有工作台记录的工作树不会动。
pub fn discard_confirmed_worktree(project: &Path, cwd: &Path, force: bool) {
    if !force && remove_owned_worktree(project, cwd, false).is_ok() {
        return;
    }
    let _ = remove_owned_worktree(project, cwd, true);
}

fn git_worktree_remove(
    project: &Path,
    checkout: &Checkout,
    root_arg: &str,
    forces: usize,
) -> Option<String> {
    #[cfg(test)]
    if SKIP_GIT_WORKTREE_REMOVE.with(|flag| flag.get()) {
        return Some("git worktree remove skipped".into());
    }
    let mut args = vec!["worktree", "remove"];
    for _ in 0..forces {
        args.push("--force");
    }
    args.push(root_arg);
    // 可能先摘掉登记，再删目录失败（目录被占用，或退出码是 0 但空目录还在）。
    let mut git_error = git_status(project, &args).err();
    if checkout.root.exists() {
        if let Ok(repo) = repository_root(project) {
            match git_status(&repo, &args) {
                Ok(()) => git_error = None,
                Err(err) if git_error.is_none() => git_error = Some(err),
                Err(_) => {}
            }
        }
    }
    git_error
}

/// `git worktree remove` 没摘掉登记时，只删链接工作树自己的管理目录，不动主库 `.git`。
fn best_effort_unregister(project: &Path, checkout: &Checkout) {
    if points_at_main(project, checkout) {
        return;
    }
    if let Some(gitdir) = linked_worktree_gitdir(&checkout.root) {
        if linked_admin_gitdir(project, &gitdir) {
            let _ = fs::remove_dir_all(&gitdir);
        }
    }
    let _ = git_status(project, &["worktree", "prune"]);
    if let Ok(repo) = repository_root(project) {
        let _ = git_status(&repo, &["worktree", "prune"]);
    }
}

fn linked_worktree_gitdir(root: &Path) -> Option<PathBuf> {
    let file = root.join(".git");
    if !file.is_file() {
        return None;
    }
    let text = fs::read_to_string(file).ok()?;
    let line = text.lines().next()?.trim();
    let rest = line.strip_prefix("gitdir:")?.trim();
    if rest.is_empty() {
        return None;
    }
    let path = PathBuf::from(rest);
    let path = if path.is_absolute() || windows_absolute(rest) {
        path
    } else {
        root.join(path)
    };
    Some(dunce_or_canonicalize(&path).unwrap_or(path))
}

fn linked_admin_gitdir(project: &Path, gitdir: &Path) -> bool {
    let Ok(Some(common)) = git_path(project, "--git-common-dir") else {
        return false;
    };
    let worktrees = common.join("worktrees");
    let gitdir = dunce_or_canonicalize(gitdir).unwrap_or_else(|_| gitdir.to_path_buf());
    let gitdir_parts = path_segments(&gitdir);
    let parent_parts = path_segments(&dunce_or_canonicalize(&worktrees).unwrap_or(worktrees));
    gitdir_parts.len() == parent_parts.len() + 1
        && gitdir_parts
            .iter()
            .zip(&parent_parts)
            .all(|(left, right)| left.eq_ignore_ascii_case(right))
}

fn after_worktree_git_remove(root: &Path) {
    #[cfg(test)]
    AFTER_WORKTREE_GIT_REMOVE.with(|hook| hook.get()(root));
    #[cfg(not(test))]
    let _ = root;
}

fn checkout_still_registered(project: &Path, checkout: &Checkout) -> bool {
    if !checkout.root.exists() {
        return false;
    }
    linked_checkout(project, &checkout.root)
        .ok()
        .flatten()
        .is_some()
        || (checkout.cwd.exists()
            && linked_checkout(project, &checkout.cwd)
                .ok()
                .flatten()
                .is_some())
}

/// 登记已经摘掉之后清磁盘。删不掉就留下，调用方仍然继续删会话。
///
/// `git worktree remove` 可能已经把文件删光，只留下空目录：Windows 上进程刚退出时
/// `RemoveDirectory` 会暂时返回「拒绝访问」或「目录非空」。`remove_dir_all` 这时也会失败，
/// 空目录要用 `remove_dir` 再试几次。主检出不能动。
fn discard_worktree_directory(project: &Path, checkout: &Checkout, marker_root: &Path) {
    if points_at_main(project, checkout) {
        return;
    }
    let repo = repository_root(project).unwrap_or_else(|_| project.to_path_buf());
    remove_worktree_tree(&checkout.root);
    if !same_path(&checkout.root, marker_root) && !is_repository_path(project, marker_root) {
        remove_worktree_tree(marker_root);
    }
    if checkout.root.exists() {
        return;
    }
    remove_empty_worktree_containers(&checkout.root, &repo);
    if !same_path(&checkout.root, marker_root) && !marker_root.exists() {
        remove_empty_worktree_containers(marker_root, &repo);
    }
}

fn worktree_dir_remove_attempts() -> u32 {
    if cfg!(windows) {
        8
    } else {
        3
    }
}

fn pause_before_dir_remove_retry(attempt: u32) {
    // Windows 要等杀死的进程和 git 放开目录句柄。其它系统只留很短的间隔。
    let step = if cfg!(windows) { 50 } else { 20 };
    std::thread::sleep(Duration::from_millis(step * u64::from(attempt + 1)));
}

pub(crate) fn remove_worktree_tree(path: &Path) {
    let attempts = worktree_dir_remove_attempts();
    for attempt in 0..attempts {
        #[cfg(test)]
        PREPARE_WORKTREE_DIR_REMOVE.with(|hook| hook.get()(path, attempt));
        match remove_dir_all_worktree(path) {
            Ok(()) => return,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) => match fs::remove_dir(path) {
                Ok(()) => return,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
                Err(_) if !path.exists() => return,
                Err(_) => {}
            },
        }
        if attempt + 1 == attempts {
            return;
        }
        pause_before_dir_remove_retry(attempt);
    }
}

fn remove_dir_all_worktree(path: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    {
        let left = FAIL_REMOVE_DIR_ALL_TIMES.with(|times| times.get());
        if left > 0 {
            FAIL_REMOVE_DIR_ALL_TIMES.with(|times| times.set(left - 1));
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "simulated remove_dir_all failure",
            ));
        }
    }
    fs::remove_dir_all(path)
}

/// 工作树根删掉之后，清掉因此变空的外壳。
/// 只到上一级（Codex 的四位目录，或 `.claude/worktrees`），外加因此变空的 `.claude`。
/// 不删仓库本身，也不顺着托管根往上删到 `.codex`。
pub(crate) fn remove_empty_worktree_containers(removed: &Path, repo: &Path) {
    let Some(parent) = removed.parent() else {
        return;
    };
    // 只收 Codex 的四位桶和 .claude/worktrees。工作台的工作树直接放在工作树目录下，那是用户选的目录，不删。
    let name = parent.file_name().and_then(|name| name.to_str()).unwrap_or("");
    let codex_bucket = name.len() == 4 && name.bytes().all(|byte| byte.is_ascii_hexdigit());
    let claude_worktrees = name == "worktrees"
        && parent.parent().and_then(|dir| dir.file_name()).and_then(|name| name.to_str()) == Some(".claude");
    if !(codex_bucket || claude_worktrees) {
        return;
    }
    if !can_remove_empty_container(parent, repo) || !remove_empty_dir_retry(parent) {
        return;
    }
    if parent.file_name().and_then(|name| name.to_str()) != Some("worktrees") {
        return;
    }
    let Some(claude) = parent.parent() else {
        return;
    };
    if claude.file_name().and_then(|name| name.to_str()) == Some(".claude")
        && can_remove_empty_container(claude, repo)
    {
        let _ = remove_empty_dir_retry(claude);
    }
}

fn can_remove_empty_container(dir: &Path, repo: &Path) -> bool {
    dir.parent().is_some() && !same_path(dir, repo)
}

fn remove_empty_dir_retry(path: &Path) -> bool {
    // 子目录刚删掉时，父目录会短暂报「非空」。真有别的内容就不要空转。
    let attempts = if cfg!(windows) { 4 } else { 2 };
    for attempt in 0..attempts {
        match fs::remove_dir(path) {
            Ok(()) => return true,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) if !path.exists() => return true,
            Err(err) if attempt > 0 && directory_not_empty(&err) => return false,
            Err(_) => {}
        }
        if attempt + 1 == attempts {
            return !path.exists();
        }
        pause_before_dir_remove_retry(attempt);
    }
    !path.exists()
}

fn directory_not_empty(err: &std::io::Error) -> bool {
    // 1.77 还没有稳定的 `ErrorKind::DirectoryNotEmpty`。
    matches!(err.raw_os_error(), Some(39 | 66 | 145))
}

fn is_repository_path(project: &Path, path: &Path) -> bool {
    if same_path(path, project) {
        return true;
    }
    repository_root(project)
        .ok()
        .is_some_and(|repo| same_path(&repo, path))
}

fn points_at_main(project: &Path, checkout: &Checkout) -> bool {
    if same_path(&checkout.root, project) || same_path(&checkout.cwd, project) {
        return true;
    }
    repository_root(project)
        .ok()
        .is_some_and(|repo| same_path(&repo, &checkout.root))
}

fn worktree_is_dirty(cwd: &Path, base: Option<&str>, project: &Path) -> bool {
    match status_porcelain(cwd) {
        Ok(text) if !text.trim().is_empty() => return true,
        Err(_) => return true,
        Ok(_) => {}
    }
    match unmerged_count(cwd, base, project) {
        Ok(count) => count > 0,
        Err(_) => true,
    }
}

fn status_porcelain(cwd: &Path) -> Result<String, String> {
    let output = git_output(cwd, &["status", "--porcelain", "--untracked-files=normal"])?;
    if !output.status.success() {
        return Err(git_failure(&output, "无法读取工作树状态"));
    }
    Ok(aiwb_proc::decode_child_bytes(&output.stdout).into_owned())
}

fn unmerged_count(cwd: &Path, base: Option<&str>, project: &Path) -> Result<u32, String> {
    let target = if let Some(name) = base.map(str::trim).filter(|name| !name.is_empty()) {
        let spec = format!("refs/heads/{name}");
        let verified = git_output(cwd, &["rev-parse", "--verify", "--quiet", &spec])?;
        if verified.status.success() {
            spec
        } else {
            git_stdout(project, &["rev-parse", "--verify", "HEAD^{commit}"])?
        }
    } else {
        git_stdout(project, &["rev-parse", "--verify", "HEAD^{commit}"])?
    };
    let range = format!("{target}..HEAD");
    let text = git_stdout(cwd, &["rev-list", "--count", &range])?;
    text.parse::<u32>().map_err(|_| "无法比较提交".to_string())
}

fn delete_recorded_branch(repo: &Path, branch: Option<&str>, base: Option<&str>, head: Option<&str>) {
    let Some(branch) = branch
        .map(str::trim)
        .filter(|name| name.starts_with("worktree-") || name.starts_with(TASK_BRANCH_PREFIX))
    else {
        return;
    };
    if base.is_some_and(|name| name == branch) {
        return;
    }
    if branch_name(repo).ok().flatten().as_deref() == Some(branch) {
        return;
    }
    let spec = format!("refs/heads/{branch}");
    let tip = git_stdout(repo, &["rev-parse", "--verify", "--quiet", &spec]).ok();
    if head.is_none() || tip.as_deref() != head {
        return;
    }
    let _ = git_status(repo, &["branch", "-D", branch]);
}

pub(crate) fn read_marker_file(path: &Path) -> Option<OwnedMarker> {
    let raw = fs::read_to_string(path).ok()?;
    parse_marker_json(&raw)
}

pub(crate) fn read_marker(cwd: &Path) -> Option<OwnedMarker> {
    let path = marker_path(cwd).ok()?;
    read_marker_file(&path)
}

fn parse_marker_json(raw: &str) -> Option<OwnedMarker> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    if value.get("version").and_then(|item| item.as_u64()) != Some(1) {
        return None;
    }
    let sha = value
        .get("sha")
        .and_then(|item| item.as_str())?
        .trim()
        .to_string();
    if sha.len() < 7 {
        return None;
    }
    let root = PathBuf::from(value.get("root").and_then(|item| item.as_str())?.trim());
    if root.as_os_str().is_empty() {
        return None;
    }
    let base = value
        .get("base")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty() && *item != "HEAD")
        .map(str::to_string);
    let branch = value
        .get("branch")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string);
    Some(OwnedMarker {
        root,
        base,
        sha,
        branch,
    })
}

fn marker_path(cwd: &Path) -> Result<PathBuf, String> {
    owned_git_file(cwd, MARKER_NAME)
}

pub(crate) fn owned_git_file(cwd: &Path, name: &str) -> Result<PathBuf, String> {
    let text = git_stdout(
        cwd,
        &["rev-parse", "--path-format=absolute", "--git-path", name],
    )?;
    Ok(resolve_git_path(cwd, &text))
}

pub(crate) fn head_sha(cwd: &Path) -> Result<String, String> {
    git_stdout(cwd, &["rev-parse", "--verify", "HEAD^{commit}"])
}

pub(crate) fn same_path(left: &Path, right: &Path) -> bool {
    match (dunce_or_canonicalize(left), dunce_or_canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn git_path(cwd: &Path, argument: &str) -> Result<Option<PathBuf>, String> {
    let output = match git_output(cwd, &["rev-parse", "--path-format=absolute", argument]) {
        Ok(output) => output,
        Err(err) if err.contains("无法运行 git") || err == "已停止" => return Err(err),
        Err(_) => return Ok(None),
    };
    if !output.status.success() {
        let stderr = aiwb_proc::decode_child_bytes(&output.stderr);
        if stderr.contains("not a git repository") || stderr.trim().is_empty() {
            return Ok(None);
        }
        return Ok(None);
    }
    let text = aiwb_proc::decode_child_bytes(&output.stdout);
    let path = resolve_git_path(cwd, text.trim());
    if path.as_os_str().is_empty() {
        return Ok(None);
    }
    Ok(Some(dunce_or_canonicalize(&path).unwrap_or(path)))
}

/// 仓库根和源目录只差大小写、斜杠或 `\\?\` 时仍算出相对路径。
/// Windows 上 `strip_prefix` 分大小写，对不上就会把已经建好的工作树丢掉。
fn relative_checkout(root: &Path, source: &Path) -> Result<PathBuf, String> {
    if let Ok(relative) = source.strip_prefix(root) {
        return Ok(relative.to_path_buf());
    }
    let root_parts = path_segments(root);
    let source_parts = path_segments(source);
    if source_parts.len() < root_parts.len() {
        return Err("工作目录不在仓库里".into());
    }
    for (root_part, source_part) in root_parts.iter().zip(&source_parts) {
        if !root_part.eq_ignore_ascii_case(source_part) {
            return Err("工作目录不在仓库里".into());
        }
    }
    let mut relative = PathBuf::new();
    for part in source_parts.iter().skip(root_parts.len()) {
        relative.push(part);
    }
    Ok(relative)
}

fn path_segments(path: &Path) -> Vec<String> {
    let text = aiwb_core::models::strip_verbatim_prefix(&path.to_string_lossy());
    text.replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

fn resolve_git_path(cwd: &Path, text: &str) -> PathBuf {
    let text = aiwb_core::models::strip_verbatim_prefix(text.trim().trim_matches('"'));
    let path = PathBuf::from(&text);
    if path.is_absolute() || windows_absolute(&text) {
        path
    } else {
        cwd.join(path)
    }
}

fn windows_absolute(text: &str) -> bool {
    let bytes = text.as_bytes();
    if text.starts_with(r"\\") || text.starts_with("//") {
        return true;
    }
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

pub(crate) fn branch_name(cwd: &Path) -> Result<Option<String>, String> {
    let output = git_output(cwd, &["branch", "--show-current"])?;
    if !output.status.success() {
        let stderr = aiwb_proc::decode_child_bytes(&output.stderr);
        let stderr = stderr.trim();
        if stderr.contains("not a git repository") {
            return Ok(None);
        }
        if stderr.is_empty() {
            return Err("无法读取当前分支".into());
        }
        return Err(stderr.to_string());
    }
    let name = aiwb_proc::decode_child_bytes(&output.stdout);
    let name = name.trim();
    if name.is_empty() || name == "HEAD" {
        return Ok(None);
    }
    Ok(Some(name.to_string()))
}

/// 与 Codex `codex-rs/worktree` 一样：这次命令不跑钩子、不启 fsmonitor，
/// 也不继承调用方的 `GIT_DIR` / `GIT_WORK_TREE`。
fn isolated_git(cwd: &Path) -> Command {
    let hooks = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut command = plain_git(cwd);
    command
        .arg("-c")
        .arg(format!("core.hooksPath={hooks}"))
        .arg("-c")
        .arg("core.fsmonitor=")
        .arg("-c")
        .arg("core.attributesFile=")
        .env("GIT_LFS_SKIP_SMUDGE", "1");
    command
}

/// 只隔开调用方的 git 环境变量。钩子、LFS、属性照用户自己的配置：
/// 交接时改的是用户的检出，LFS 文件要还原成真内容，不能留下指针。
fn plain_git(cwd: &Path) -> Command {
    let mut command = Command::new("git");
    for name in [
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CEILING_DIRECTORIES",
        "GIT_CONFIG",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_COUNT",
        "GIT_OBJECT_DIRECTORY",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_IMPLICIT_WORK_TREE",
        "GIT_GRAFT_FILE",
        "GIT_INDEX_FILE",
        "GIT_NO_REPLACE_OBJECTS",
        "GIT_REPLACE_REF_BASE",
        "GIT_PREFIX",
        "GIT_SHALLOW_FILE",
        "GIT_COMMON_DIR",
    ] {
        command.env_remove(name);
    }
    command
        .current_dir(cwd)
        .arg("-c")
        .arg("safe.bareRepository=explicit")
        .env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    aiwb_proc::apply_utf8_env_std(&mut command);
    super::hide_console(&mut command);
    command
}

/// 用用户自己的 git 配置跑一条会改检出的命令（切分支、铺文件、清理），单条有时限。
pub(crate) fn user_git_status(cwd: &Path, args: &[&str]) -> Result<(), String> {
    if !cwd.is_dir() {
        return Err("项目不存在".into());
    }
    let mut command = plain_git(cwd);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = command
        .spawn()
        .map_err(|err| format!("无法运行 git: {err}"))?;
    let output = capture_git(child)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(git_failure(&output, "git 失败"))
    }
}

pub(crate) fn git_output(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    git_output_env(root, args, &[])
}

/// `envs` 在隔离之后再设，用来指定临时 index 或提交者。
fn git_output_env(
    root: &Path,
    args: &[&str],
    envs: &[(&str, &std::ffi::OsStr)],
) -> Result<std::process::Output, String> {
    if !root.is_dir() {
        return Err("项目不存在".into());
    }
    let mut command = isolated_git(root);
    command.envs(envs.iter().copied());
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = command
        .spawn()
        .map_err(|err| format!("无法运行 git: {err}"))?;
    capture_git(child)
}

fn capture_git(mut child: std::process::Child) -> Result<std::process::Output, String> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_handle = std::thread::spawn(move || read_pipe(stdout));
    let err_handle = std::thread::spawn(move || read_pipe(stderr));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > GIT_COMMAND_LIMIT => {
                let _ = child.kill();
                kill_pid(child.id());
                let _ = child.wait();
                let _ = out_handle.join();
                let _ = err_handle.join();
                return Err("等待 git 超时，已停止这次操作。".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
            Err(err) => return Err(format!("无法等待 git: {err}")),
        }
    };
    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

fn read_pipe(pipe: Option<impl Read>) -> Vec<u8> {
    let mut buf = Vec::new();
    if let Some(mut pipe) = pipe {
        let _ = pipe.read_to_end(&mut buf);
    }
    buf
}

pub(crate) fn git_stdout(cwd: &Path, args: &[&str]) -> Result<String, String> {
    git_stdout_env(cwd, args, &[])
}

pub(crate) fn git_stdout_env(cwd: &Path, args: &[&str], envs: &[(&str, &std::ffi::OsStr)]) -> Result<String, String> {
    let output = git_output_env(cwd, args, envs)?;
    if !output.status.success() {
        return Err(git_failure(&output, "git 失败"));
    }
    let text = aiwb_proc::decode_child_bytes(&output.stdout);
    let text = text.trim();
    if text.is_empty() {
        return Err("git 没有输出".into());
    }
    Ok(text.to_string())
}

pub(crate) fn git_status(cwd: &Path, args: &[&str]) -> Result<(), String> {
    git_status_env(cwd, args, &[])
}

pub(crate) fn git_status_env(cwd: &Path, args: &[&str], envs: &[(&str, &std::ffi::OsStr)]) -> Result<(), String> {
    let output = git_output_env(cwd, args, envs)?;
    if output.status.success() {
        return Ok(());
    }
    Err(git_failure(&output, "git 失败"))
}

pub(crate) fn git_failure(output: &std::process::Output, fallback: &str) -> String {
    let stderr = aiwb_proc::decode_child_bytes(&output.stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        fallback.to_string()
    } else {
        stderr.to_string()
    }
}

pub(crate) fn dunce_or_canonicalize(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map(|item| {
            let text = item.to_string_lossy();
            PathBuf::from(aiwb_core::models::strip_verbatim_prefix(&text))
        })
        .map_err(|err| format!("无法解析路径: {err}"))
}

#[cfg(test)]
mod tests {
    use super::super::current_branch;
    use super::*;
    use std::fs;
    use std::process::{Command, Stdio};

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-workbench-wt-{name}-{}-{}",
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
        fs::write(root.join("note.txt"), "one\n").unwrap();
        run_git(&root, &["add", "note.txt"]);
        run_git(
            &root,
            &["-c", "commit.gpgsign=false", "commit", "-m", "base"],
        );
        root
    }

    #[test]
    fn task_worktree_is_detached_and_keeps_subdir() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("task");
        fs::create_dir_all(repo.join("app")).unwrap();
        fs::write(repo.join("app/main.rs"), "fn main() {}
").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["-c", "commit.gpgsign=false", "commit", "-m", "app"]);
        let managed = scratch("task-managed");

        let made = create_task_worktree(&repo.join("app"), &managed, &NewWorktree::default()).unwrap();
        assert_eq!(made.base.as_deref(), Some("main"));
        assert!(made.cwd.join("main.rs").is_file());
        assert!(made.cwd.ends_with("app"));
        assert_eq!(current_branch(&made.cwd).unwrap(), None);
        assert_eq!(crate::checked_out_branch(&made.cwd), None);
        assert_eq!(crate::checked_out_branch(&repo.join("app")).as_deref(), Some("main"));

        remove_checkout(&repo, &made.root);
        let _ = fs::remove_dir_all(managed);
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn task_worktree_is_owned_and_removed() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("task-owned");
        let managed = scratch("task-owned-managed");
        let made = create_task_worktree(&repo, &managed, &NewWorktree::default()).unwrap();
        assert_eq!(
            delete_preview(&repo, &made.cwd),
            DeletePreview { owned: true, dirty: false }
        );
        fs::write(made.cwd.join("draft.txt"), "x").unwrap();
        assert!(delete_preview(&repo, &made.cwd).dirty);

        discard_confirmed_worktree(&repo, &made.cwd, true);
        assert!(!made.root.exists());
        let _ = fs::remove_dir_all(managed);
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn empty_and_plain_directories_have_no_commit() {
        if !git_ok() {
            return;
        }
        let plain = scratch("plain");
        assert_eq!(repo_has_commit(&plain).unwrap(), false);
        run_git(&plain, &["init"]);
        assert_eq!(repo_has_commit(&plain).unwrap(), false);
        let _ = fs::remove_dir_all(plain);
    }

    #[test]
    fn task_worktree_is_linked_and_binds_one_codex_thread() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("linked");
        let managed = scratch("managed");
        let made = create_task_worktree(&repo, &managed, &NewWorktree::default()).unwrap();
        assert!(made.cwd.starts_with(dunce_or_canonicalize(&managed).unwrap()));
        assert!(made.cwd.join("note.txt").is_file());
        let linked = linked_checkout(&repo, &made.cwd).unwrap().unwrap();
        assert_eq!(linked.branch, None);
        assert!(linked_checkout(&repo, &repo).unwrap().is_none());

        bind_codex_thread(&made.cwd, "thread-1").unwrap();
        bind_codex_thread(&made.cwd, "thread-1").unwrap();
        assert!(bind_codex_thread(&made.cwd, "other").is_err());

        remove_checkout(&repo, &made.root);
        assert!(!made.root.exists());
        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(managed);
    }

    #[test]
    fn owned_checkout_reports_base_and_only_removes_itself() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("owned");
        let (base, sha) = source_revision(&repo).unwrap();
        assert_eq!(base.as_deref(), Some("main"));
        let managed = scratch("owned-managed");
        let checkout = create_task_worktree(&repo, &managed, &NewWorktree::default()).unwrap();
        let described = session_worktree(&repo, &checkout.cwd).unwrap();
        assert!(described.owned);
        assert_eq!(described.base.as_deref(), Some("main"));
        assert!(described.sha.unwrap().starts_with(&sha[..7]));
        assert_eq!(
            delete_preview(&repo, &checkout.cwd),
            DeletePreview {
                owned: true,
                dirty: false
            }
        );
        assert!(!remove_owned_worktree(&repo, &repo, true).unwrap());
        assert!(repo.join("note.txt").is_file());

        fs::write(checkout.cwd.join("extra.txt"), "dirty\n").unwrap();
        assert!(delete_preview(&repo, &checkout.cwd).dirty);
        assert!(remove_owned_worktree(&repo, &checkout.cwd, false).is_err());
        assert!(checkout.root.exists());

        run_git(&checkout.cwd, &["add", "extra.txt"]);
        run_git(
            &checkout.cwd,
            &["-c", "commit.gpgsign=false", "commit", "-m", "wip"],
        );
        assert!(delete_preview(&repo, &checkout.cwd).dirty);
        fs::write(checkout.cwd.join("extra.txt"), "dirty again\n").unwrap();
        assert!(delete_preview(&repo, &checkout.cwd).dirty);

        run_git(&checkout.cwd, &["reset", "--hard", &sha]);
        assert!(!delete_preview(&repo, &checkout.cwd).dirty);
        assert!(remove_owned_worktree(&repo, &checkout.cwd, false).unwrap());
        assert!(!checkout.root.exists());

        let manual = scratch("manual");
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "hand-made",
                manual.to_str().unwrap(),
            ],
        );
        assert!(!session_worktree(&repo, &manual).unwrap().owned);
        assert!(!remove_owned_worktree(&repo, &manual, true).unwrap());
        assert!(manual.join("note.txt").is_file());
        run_git(&repo, &["worktree", "remove", manual.to_str().unwrap()]);
        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(managed);
    }

    #[test]
    fn removing_a_recorded_claude_worktree_deletes_its_branch() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("claude-remove");
        let (base, sha) = source_revision(&repo).unwrap();
        let path = repo.join(".claude").join("worktrees").join("wt-abc12345");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "worktree-wt-abc12345",
                path.to_str().unwrap(),
            ],
        );
        record_owned_worktree(
            &path,
            &OwnedMarker {
                root: path.clone(),
                base,
                sha,
                branch: Some("worktree-wt-abc12345".into()),
            },
        )
        .unwrap();
        assert!(remove_owned_worktree(&repo, &path, false).unwrap());
        assert!(!path.exists());
        let listed = Command::new("git")
            .args(["branch", "--list", "worktree-wt-abc12345"])
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&listed.stdout).trim().is_empty());
        let _ = fs::remove_dir_all(repo);
    }

    fn leave_empty_worktree_dir(root: &Path) {
        let _ = fs::create_dir_all(root);
    }

    struct ClearRemoveHook;

    impl Drop for ClearRemoveHook {
        fn drop(&mut self) {
            super::AFTER_WORKTREE_GIT_REMOVE
                .with(|hook| hook.set(super::noop_after_worktree_remove));
        }
    }

    fn branch_listed(repo: &Path, name: &str) -> bool {
        let listed = Command::new("git")
            .args(["branch", "--list", name])
            .current_dir(repo)
            .output()
            .unwrap();
        !String::from_utf8_lossy(&listed.stdout).trim().is_empty()
    }

    fn worktree_listed(repo: &Path, path: &Path) -> bool {
        let mut command = Command::new("git");
        command
            .args(["worktree", "list", "--porcelain"])
            .current_dir(repo)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_COMMON_DIR");
        let listed = command.output().unwrap();
        let text = String::from_utf8_lossy(&listed.stdout);
        let want = listed_worktree_key(path);
        text.lines().any(|line| {
            let Some(raw) = line.strip_prefix("worktree ") else {
                return false;
            };
            listed_worktree_key(Path::new(raw.trim())) == want
        })
    }

    /// porcelain 里的路径和测试里的 `PathBuf` 可能只是分隔符或符号链接不同。
    /// 按规范化后的路径相等，不用子串包含，避免主检出路径把子目录误判成还在列表里。
    fn listed_worktree_key(path: &Path) -> String {
        let resolved = super::dunce_or_canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        resolved
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string()
    }

    #[test]
    fn git_remove_that_leaves_the_directory_still_finishes() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("leave-dir");
        let (base, sha) = source_revision(&repo).unwrap();
        let path = repo.join(".claude").join("worktrees").join("wt-leave01");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "worktree-wt-leave01",
                path.to_str().unwrap(),
            ],
        );
        record_owned_worktree(
            &path,
            &OwnedMarker {
                root: path.clone(),
                base,
                sha,
                branch: Some("worktree-wt-leave01".into()),
            },
        )
        .unwrap();
        let _hook = ClearRemoveHook;
        super::AFTER_WORKTREE_GIT_REMOVE.with(|hook| hook.set(leave_empty_worktree_dir));
        assert!(remove_owned_worktree(&repo, &path, true).unwrap());
        assert!(!path.exists(), "空目录应被清掉");
        assert!(
            !repo.join(".claude").join("worktrees").exists(),
            "空的 .claude/worktrees 应被清掉"
        );
        assert!(!repo.join(".claude").exists(), "空的 .claude 应被清掉");
        assert!(repo.join("note.txt").is_file());
        assert!(!worktree_listed(&repo, &path));
        assert!(!branch_listed(&repo, "worktree-wt-leave01"));
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn empty_directory_is_removed_when_remove_dir_all_fails() {
        if !git_ok() {
            return;
        }
        let (repo, path, branch) = owned_claude("rmdir-fallback");
        struct ClearFail;
        impl Drop for ClearFail {
            fn drop(&mut self) {
                super::FAIL_REMOVE_DIR_ALL_TIMES.with(|times| times.set(0));
                super::AFTER_WORKTREE_GIT_REMOVE
                    .with(|hook| hook.set(super::noop_after_worktree_remove));
            }
        }
        let _clear = ClearFail;
        super::FAIL_REMOVE_DIR_ALL_TIMES.with(|times| times.set(1));
        super::AFTER_WORKTREE_GIT_REMOVE.with(|hook| hook.set(leave_empty_worktree_dir));
        assert!(remove_owned_worktree(&repo, &path, true).unwrap());
        assert!(!path.exists(), "remove_dir_all 失败后空目录仍应被 rmdir");
        assert!(!repo.join(".claude").exists());
        assert!(!worktree_listed(&repo, &path));
        assert!(!branch_listed(&repo, &branch));
        assert!(repo.join("note.txt").is_file());
        let _ = fs::remove_dir_all(repo);
    }

    #[cfg(unix)]
    #[test]
    fn directory_locked_on_the_first_try_is_removed_on_retry() {
        if !git_ok() {
            return;
        }
        let (repo, path, branch) = owned_claude("rmdir-retry");
        let parent = path.parent().unwrap().to_path_buf();
        struct ClearHook;
        impl Drop for ClearHook {
            fn drop(&mut self) {
                super::PREPARE_WORKTREE_DIR_REMOVE
                    .with(|hook| hook.set(super::noop_prepare_worktree_dir_remove));
                super::AFTER_WORKTREE_GIT_REMOVE
                    .with(|hook| hook.set(super::noop_after_worktree_remove));
            }
        }
        fn lock_once(target: &Path, attempt: u32) {
            if target.file_name().and_then(|name| name.to_str()) != Some("rmdir-retry") {
                return;
            }
            let Some(parent) = target.parent() else {
                return;
            };
            use std::os::unix::fs::PermissionsExt;
            let Ok(meta) = fs::metadata(parent) else {
                return;
            };
            let mut perms = meta.permissions();
            perms.set_mode(if attempt == 0 { 0o555 } else { 0o755 });
            let _ = fs::set_permissions(parent, perms);
        }
        let _clear = ClearHook;
        let _unlock = UnlockDir(parent);
        super::AFTER_WORKTREE_GIT_REMOVE.with(|hook| hook.set(leave_empty_worktree_dir));
        super::PREPARE_WORKTREE_DIR_REMOVE.with(|hook| hook.set(lock_once));
        assert!(remove_owned_worktree(&repo, &path, true).unwrap());
        assert!(!path.exists(), "第一次删不掉的空目录应在重试后消失");
        assert!(!worktree_listed(&repo, &path));
        assert!(!branch_listed(&repo, &branch));
        assert!(repo.join("note.txt").is_file());
        let _ = fs::remove_dir_all(repo);
    }

    #[cfg(unix)]
    #[test]
    fn leftover_directory_that_cannot_be_removed_still_unregisters() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("leave-locked");
        let (base, sha) = source_revision(&repo).unwrap();
        let path = repo.join(".claude").join("worktrees").join("wt-locked1");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "worktree-wt-locked1",
                path.to_str().unwrap(),
            ],
        );
        record_owned_worktree(
            &path,
            &OwnedMarker {
                root: path.clone(),
                base,
                sha,
                branch: Some("worktree-wt-locked1".into()),
            },
        )
        .unwrap();
        let parent = path.parent().unwrap().to_path_buf();
        let (removed, still_there) = {
            let _unlock = UnlockDir(parent);
            let _hook = ClearRemoveHook;
            super::AFTER_WORKTREE_GIT_REMOVE.with(|hook| hook.set(leave_undeletable_worktree));
            let removed = remove_owned_worktree(&repo, &path, true);
            (removed, path.exists())
        };
        assert!(removed.unwrap());
        assert!(still_there, "删不掉的空目录不能让这次删除失败");
        assert!(!worktree_listed(&repo, &path));
        assert!(!branch_listed(&repo, "worktree-wt-locked1"));
        let _ = fs::remove_dir_all(repo);
    }

    #[cfg(unix)]
    struct UnlockDir(PathBuf);

    #[cfg(unix)]
    impl Drop for UnlockDir {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = fs::metadata(&self.0) {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                let _ = fs::set_permissions(&self.0, perms);
            }
        }
    }

    #[cfg(unix)]
    fn leave_undeletable_worktree(root: &Path) {
        let _ = fs::create_dir_all(root);
        let Some(parent) = root.parent() else {
            return;
        };
        use std::os::unix::fs::PermissionsExt;
        let Ok(meta) = fs::metadata(parent) else {
            return;
        };
        let mut perms = meta.permissions();
        perms.set_mode(0o555);
        let _ = fs::set_permissions(parent, perms);
    }

    fn owned_claude(name: &str) -> (PathBuf, PathBuf, String) {
        let repo = repo_with_commit(name);
        let (base, sha) = source_revision(&repo).unwrap();
        let branch = format!("worktree-{name}");
        let path = repo.join(".claude").join("worktrees").join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        run_git(
            &repo,
            &["worktree", "add", "-b", &branch, path.to_str().unwrap()],
        );
        record_owned_worktree(
            &path,
            &OwnedMarker {
                root: path.clone(),
                base,
                sha,
                branch: Some(branch.clone()),
            },
        )
        .unwrap();
        (repo, path, branch)
    }

    #[test]
    fn a_recorded_branch_that_moved_on_is_kept() {
        if !git_ok() {
            return;
        }
        let (repo, path, branch) = owned_claude("moved-on");
        // 分支被交到别处、又提交过：工作树停在旧提交上，分支往前走了。
        run_git(&path, &["switch", "-q", "--detach"]);
        let tree = git_stdout(&repo, &["rev-parse", "HEAD^{tree}"]).unwrap();
        let head = git_stdout(&repo, &["rev-parse", "HEAD"]).unwrap();
        let ahead = git_stdout(&repo, &["commit-tree", &tree, "-p", &head, "-m", "later"]).unwrap();
        run_git(&repo, &["update-ref", &format!("refs/heads/{branch}"), &ahead]);
        assert!(remove_owned_worktree(&repo, &path, true).unwrap());
        assert!(branch_listed(&repo, &branch), "分支上有工作树之外的提交，不能删");
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn non_force_remove_failure_retries_with_force() {
        if !git_ok() {
            return;
        }
        let (repo, path, branch) = owned_claude("retry-dirty");
        fs::write(path.join("extra.txt"), "dirty\n").unwrap();
        assert!(remove_owned_worktree(&repo, &path, false).is_err());
        assert!(path.join("extra.txt").is_file());
        assert!(worktree_listed(&repo, &path));
        assert!(branch_listed(&repo, &branch));

        discard_confirmed_worktree(&repo, &path, false);
        assert!(
            !path.exists(),
            "确认删除后应强制去掉非 force 删不掉的工作树"
        );
        assert!(!worktree_listed(&repo, &path));
        assert!(!branch_listed(&repo, &branch));
        assert!(repo.join("note.txt").is_file());
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn clean_locked_worktree_is_removed_after_confirmed_delete() {
        if !git_ok() {
            return;
        }
        let (repo, path, branch) = owned_claude("retry-lock");
        let preview = delete_preview(&repo, &path);
        assert!(preview.owned);
        assert!(!preview.dirty);
        run_git(&repo, &["worktree", "lock", path.to_str().unwrap()]);
        let err = remove_owned_worktree(&repo, &path, false).unwrap_err();
        assert!(
            err.to_lowercase().contains("locked"),
            "不带 --force 应在摘登记前失败: {err}"
        );
        assert!(path.exists());
        assert!(worktree_listed(&repo, &path));
        assert!(branch_listed(&repo, &branch));

        discard_confirmed_worktree(&repo, &path, false);
        assert!(!path.exists());
        assert!(!worktree_listed(&repo, &path));
        assert!(!branch_listed(&repo, &branch));
        assert!(repo.join("note.txt").is_file());
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn forced_delete_removes_a_locked_worktree() {
        if !git_ok() {
            return;
        }
        let (repo, path, branch) = owned_claude("force-lock");
        run_git(&repo, &["worktree", "lock", path.to_str().unwrap()]);
        assert!(remove_owned_worktree(&repo, &path, true).unwrap());
        assert!(!path.exists());
        assert!(!worktree_listed(&repo, &path));
        assert!(!branch_listed(&repo, &branch));
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn git_remove_failure_still_clears_registration_on_confirmed_delete() {
        if !git_ok() {
            return;
        }
        let (repo, path, branch) = owned_claude("skip-git");
        struct ClearSkip;
        impl Drop for ClearSkip {
            fn drop(&mut self) {
                super::SKIP_GIT_WORKTREE_REMOVE.with(|flag| flag.set(false));
            }
        }
        let _clear = ClearSkip;
        super::SKIP_GIT_WORKTREE_REMOVE.with(|flag| flag.set(true));
        assert!(remove_owned_worktree(&repo, &path, false).is_err());
        assert!(path.exists(), "未确认强制时不能把 git 失败当成已经删掉");
        assert!(worktree_listed(&repo, &path));
        assert!(branch_listed(&repo, &branch));

        discard_confirmed_worktree(&repo, &path, false);
        assert!(
            !worktree_listed(&repo, &path),
            "git worktree remove 失败后仍应摘掉登记"
        );
        assert!(!path.exists());
        assert!(!branch_listed(&repo, &branch));
        assert!(repo.join("note.txt").is_file());
        let _ = fs::remove_dir_all(repo);
    }

    #[cfg(unix)]
    #[test]
    fn confirmed_delete_returns_when_the_worktree_stays_registered() {
        if !git_ok() {
            return;
        }
        let (repo, path, branch) = owned_claude("stay-reg");
        let gitdir = super::linked_worktree_gitdir(&path).expect("gitdir");
        let (still_there, still_listed, branch_there) = {
            let _unlock_tree = UnlockDir(path.clone());
            let _unlock_gitdir = UnlockDir(gitdir.clone());
            chmod_mode(&path, 0o555);
            chmod_mode(&gitdir, 0o555);
            assert!(
                remove_owned_worktree(&repo, &path, true).is_err(),
                "目录和管理目录都删不掉时，低层删除仍应失败"
            );
            discard_confirmed_worktree(&repo, &path, true);
            (
                path.exists(),
                worktree_listed(&repo, &path),
                branch_listed(&repo, &branch),
            )
        };
        assert!(still_there, "删不掉的目录应留下");
        assert!(still_listed, "登记还在也不能让确认删除返回失败");
        assert!(branch_there);
        assert!(repo.join("note.txt").is_file());
        let _ = fs::remove_dir_all(repo);
    }

    #[cfg(unix)]
    fn chmod_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path).unwrap().permissions();
        perms.set_mode(mode);
        fs::set_permissions(path, perms).unwrap();
    }

    #[test]
    fn confirmed_delete_leaves_the_main_checkout_and_unrecorded_worktree() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("keep-main");
        discard_confirmed_worktree(&repo, &repo, false);
        discard_confirmed_worktree(&repo, &repo, true);
        assert!(repo.join("note.txt").is_file());
        let manual = scratch("keep-manual");
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "hand-made-keep",
                manual.to_str().unwrap(),
            ],
        );
        discard_confirmed_worktree(&repo, &manual, true);
        assert!(manual.join("note.txt").is_file());
        assert!(worktree_listed(&repo, &manual));
        run_git(&repo, &["worktree", "remove", manual.to_str().unwrap()]);
        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(manual);
    }

    #[test]
    fn windows_paths_still_resolve_inside_the_checkout() {
        let root = PathBuf::from(r"C:\Users\admin\wt-git");
        let source = PathBuf::from(r"\\?\C:\Users\Admin\wt-git\src");
        assert_eq!(
            relative_checkout(&root, &source).unwrap(),
            PathBuf::from("src")
        );
        assert_eq!(
            relative_checkout(
                Path::new("C:/Users/admin/wt-git"),
                Path::new(r"C:\Users\admin\wt-git\src\app"),
            )
            .unwrap(),
            PathBuf::from("src").join("app")
        );
        assert_eq!(
            relative_checkout(&root, Path::new(r"C:\Users\admin\wt-git")).unwrap(),
            PathBuf::new()
        );
        assert!(relative_checkout(&root, Path::new(r"D:\other\wt-git")).is_err());

        let cwd = PathBuf::from(r"C:\Users\admin\.codex\worktrees\da68\wt-git");
        assert_eq!(
            resolve_git_path(
                &cwd,
                r"\\?\C:\Users\admin\repo\.git\worktrees\wt-git\ai-workbench-worktree.json",
            ),
            PathBuf::from(r"C:\Users\admin\repo\.git\worktrees\wt-git\ai-workbench-worktree.json")
        );
        assert_eq!(
            resolve_git_path(&cwd, "codex-thread.json"),
            cwd.join("codex-thread.json")
        );
    }

    #[test]
    fn fsmonitor_and_post_checkout_hook_do_not_block_the_checkout() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("hooks");
        let mark = scratch("hook-mark");
        let hook_ran = mark.join("hook-ran");
        let monitor_ran = mark.join("monitor-ran");
        let hooks = repo.join(".git").join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("post-checkout");
        fs::write(
            &hook,
            format!(
                "#!/bin/sh\necho ran > {}\nsleep 30\n",
                shell_quote(&hook_ran)
            ),
        )
        .unwrap();
        make_executable(&hook);
        let monitor = mark.join("fsmonitor");
        fs::write(
            &monitor,
            format!(
                "#!/bin/sh\necho ran > {}\nsleep 30\n",
                shell_quote(&monitor_ran)
            ),
        )
        .unwrap();
        make_executable(&monitor);
        run_git(
            &repo,
            &["config", "core.fsmonitor", monitor.to_str().unwrap()],
        );
        let managed = scratch("hooks-managed");
        let started = std::time::Instant::now();
        let checkout = create_task_worktree(&repo, &managed, &NewWorktree::default()).unwrap();
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "checkout waited on a hook or fsmonitor"
        );
        assert!(checkout.cwd.join("note.txt").is_file());
        assert!(!hook_ran.exists(), "post-checkout hook ran");
        assert!(!monitor_ran.exists(), "fsmonitor ran");
        assert!(session_worktree(&repo, &checkout.cwd).unwrap().owned);
        remove_checkout(&repo, &checkout.root);
        assert!(!checkout.root.exists());
        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(managed);
        let _ = fs::remove_dir_all(mark);
    }

    #[test]
    fn task_worktree_starts_from_the_chosen_branch_or_carries_local_changes() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("start");
        run_git(&repo, &["config", "core.autocrlf", "false"]);
        run_git(&repo, &["branch", "feature"]);
        run_git(&repo, &["switch", "-q", "feature"]);
        fs::write(repo.join("note.txt"), "feature\n").unwrap();
        run_git(&repo, &["-c", "commit.gpgsign=false", "commit", "-qam", "feature"]);
        run_git(&repo, &["switch", "-q", "main"]);
        fs::write(repo.join("note.txt"), "local edit\n").unwrap();
        fs::write(repo.join("new.txt"), "untracked\n").unwrap();
        let managed = scratch("start-managed");

        let plain = create_task_worktree(&repo, &managed, &NewWorktree::default()).unwrap();
        assert_eq!(fs::read_to_string(plain.cwd.join("note.txt")).unwrap(), "one\n");
        assert!(!plain.cwd.join("new.txt").exists());

        let carried = create_task_worktree(
            &repo,
            &managed,
            &NewWorktree { base: Some("main".into()), carry_changes: true },
        )
        .unwrap();
        assert_eq!(fs::read_to_string(carried.cwd.join("note.txt")).unwrap(), "local edit\n");
        assert_eq!(fs::read_to_string(carried.cwd.join("new.txt")).unwrap(), "untracked\n");
        assert_eq!(head_sha(&carried.cwd).unwrap(), plain.sha, "带过去的改动不提交");
        assert_eq!(
            fs::read_to_string(repo.join("note.txt")).unwrap(),
            "local edit\n",
            "源目录不受影响"
        );
        assert!(git_output(&repo, &["stash", "list"]).unwrap().stdout.is_empty());

        let feature = create_task_worktree(
            &repo,
            &managed,
            &NewWorktree { base: Some("feature".into()), carry_changes: true },
        )
        .unwrap();
        assert_eq!(feature.base.as_deref(), Some("feature"));
        assert_eq!(fs::read_to_string(feature.cwd.join("note.txt")).unwrap(), "feature\n");
        assert!(!feature.cwd.join("new.txt").exists(), "别的分支不带本地改动");
        assert!(create_task_worktree(
            &repo,
            &managed,
            &NewWorktree { base: Some("missing".into()), carry_changes: false },
        )
        .is_err());

        for made in [plain, carried, feature] {
            remove_checkout(&repo, &made.root);
        }
        let _ = fs::remove_dir_all(managed);
        let _ = fs::remove_dir_all(repo);
    }

    fn relative_checkout(root: &Path, source: &Path) -> Result<PathBuf, String> {
        super::relative_checkout(root, source)
    }

    fn resolve_git_path(cwd: &Path, text: &str) -> PathBuf {
        super::resolve_git_path(cwd, text)
    }

    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
    }

    fn make_executable(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(path).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(path, perms).unwrap();
        }
        let _ = path;
    }
}
