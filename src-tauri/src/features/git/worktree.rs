//! 新建会话用的 Git 工作树。
//!
//! Codex 的布局对齐 `openai/codex` `codex-rs/worktree`（2026-10-18 main）：
//! 在托管根目录下建 `{4位十六进制}/{仓库名}`，`git worktree add --detach`，
//! 再 `reset --hard`。CLI 的 `WorktreeSettings::for_cli` 关闭自动清理。
//! app-server 的 `thread/start` 只收 `cwd`，没有创建工作树的 RPC。
//! 这些 git 命令同样关掉钩子和 fsmonitor。`git reset --hard` 会调用
//! `core.fsmonitor`；它不返回时，文件已经在磁盘上，记录和 thread/start 都还没开始。
//!
//! Claude Code 的 `--worktree <name>` 把工作树放在仓库 `.claude/worktrees/<name>`，
//! 分支名是 `worktree-<name>`。这里只算出路径和名字，由适配器把旗标交给 CLI。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 单条 git 的上限。钩子或 fsmonitor 卡住时要能返回，而不是一直占着启动。
const GIT_COMMAND_LIMIT: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkout {
    /// 会话要使用的工作目录。源目录在仓库子目录里时，保留相对位置。
    pub cwd: PathBuf,
    /// `git worktree remove` 用的检出根。
    pub root: PathBuf,
    /// 有名字才是分支。Codex 托管检出是分离头指针，这里是 `None`。
    pub branch: Option<String>,
}

/// Claude `--worktree` 会自己创建的目标。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeWorktreePlan {
    pub name: String,
    pub path: PathBuf,
    pub branch: String,
}

/// 一次「新建会话」的取消位。停止按钮要能打断还没返回的 git 和 Agent 进程。
struct StartSlot {
    cancelled: AtomicBool,
    pids: Mutex<Vec<u32>>,
}

tokio::task_local! {
    static ACTIVE_START: Arc<StartSlot>;
}

thread_local! {
    static SUPPRESS_CANCEL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
thread_local! {
    static GIT_BLOCKED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static GIT_CALLS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
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

/// 测试里拦住 `git`。列会话的路径不能靠它识别工作树。
#[cfg(test)]
pub struct GitGuard;

#[cfg(test)]
pub fn block_git() -> GitGuard {
    GIT_CALLS.with(|calls| calls.set(0));
    GIT_BLOCKED.with(|flag| flag.set(true));
    GitGuard
}

#[cfg(test)]
impl GitGuard {
    pub fn calls(&self) -> u32 {
        GIT_CALLS.with(|calls| calls.get())
    }
}

#[cfg(test)]
impl Drop for GitGuard {
    fn drop(&mut self) {
        GIT_BLOCKED.with(|flag| flag.set(false));
    }
}

#[cfg(test)]
fn reject_blocked_git() -> Result<(), String> {
    if !GIT_BLOCKED.with(|flag| flag.get()) {
        return Ok(());
    }
    GIT_CALLS.with(|calls| calls.set(calls.get().saturating_add(1)));
    Err("测试禁止调用 git".into())
}

fn starts() -> &'static Mutex<std::collections::HashMap<String, Arc<StartSlot>>> {
    static STARTS: std::sync::OnceLock<Mutex<std::collections::HashMap<String, Arc<StartSlot>>>> =
        std::sync::OnceLock::new();
    STARTS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn latches() -> &'static Mutex<std::collections::HashMap<String, Instant>> {
    static LATCHES: std::sync::OnceLock<Mutex<std::collections::HashMap<String, Instant>>> =
        std::sync::OnceLock::new();
    LATCHES.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

pub struct WorktreeStart {
    project_id: String,
    slot: Arc<StartSlot>,
}

/// 把子进程登记到当前这次启动。Drop 时摘掉，避免之后误杀复用的 pid。
pub struct StartChild {
    slot: Option<Arc<StartSlot>>,
    pid: u32,
}

impl WorktreeStart {
    pub fn begin(project_id: &str) -> Result<Self, String> {
        let mut latches = latches().lock().unwrap();
        if let Some(at) = latches.remove(project_id) {
            if at.elapsed() < Duration::from_secs(30) {
                return Err("已停止".into());
            }
        }
        drop(latches);
        let mut starts = starts().lock().unwrap();
        if starts.contains_key(project_id) {
            return Err("这个项目正在建立会话".into());
        }
        let slot = Arc::new(StartSlot {
            cancelled: AtomicBool::new(false),
            pids: Mutex::new(Vec::new()),
        });
        starts.insert(project_id.to_string(), Arc::clone(&slot));
        Ok(Self {
            project_id: project_id.to_string(),
            slot,
        })
    }

    /// 这次 future 里的 git 和 Agent 进程都算同一次启动，await 换线程也还在。
    pub async fn drive<F, T>(&self, fut: F) -> T
    where
        F: std::future::Future<Output = T>,
    {
        ACTIVE_START.scope(Arc::clone(&self.slot), fut).await
    }
}

impl Drop for WorktreeStart {
    fn drop(&mut self) {
        let mut starts = starts().lock().unwrap();
        if let Some(current) = starts.get(&self.project_id) {
            if Arc::ptr_eq(current, &self.slot) {
                starts.remove(&self.project_id);
            }
        }
    }
}

impl Drop for StartChild {
    fn drop(&mut self) {
        let Some(slot) = self.slot.take() else {
            return;
        };
        slot.pids.lock().unwrap().retain(|pid| *pid != self.pid);
    }
}

pub fn note_start_child(pid: u32) -> StartChild {
    let slot = ACTIVE_START.try_with(Arc::clone).ok();
    if let Some(slot) = slot.as_ref() {
        slot.pids.lock().unwrap().push(pid);
    }
    StartChild { slot, pid }
}

pub fn start_was_cancelled() -> bool {
    ACTIVE_START
        .try_with(|slot| slot.cancelled.load(Ordering::SeqCst))
        .unwrap_or(false)
}

/// 停止还在建立的会话。进程还没登记时先记下，随后的 begin 直接失败。
pub fn cancel_worktree_start(project_id: &str) {
    let starts = starts().lock().unwrap();
    if let Some(slot) = starts.get(project_id) {
        slot.cancelled.store(true, Ordering::SeqCst);
        let pids = slot.pids.lock().unwrap().clone();
        drop(starts);
        for pid in pids {
            kill_pid(pid);
        }
        return;
    }
    drop(starts);
    latches()
        .lock()
        .unwrap()
        .insert(project_id.to_string(), Instant::now());
}

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

struct SuppressCancel;

impl SuppressCancel {
    fn enter() -> Self {
        SUPPRESS_CANCEL.with(|flag| flag.set(true));
        Self
    }
}

impl Drop for SuppressCancel {
    fn drop(&mut self) {
        SUPPRESS_CANCEL.with(|flag| flag.set(false));
    }
}

fn start_cancelled() -> bool {
    if SUPPRESS_CANCEL.with(|flag| flag.get()) {
        return false;
    }
    start_was_cancelled()
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
    let stderr = crate::encoding::decode_child_bytes(&output.stderr);
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
    let text = crate::encoding::decode_child_bytes(&output.stdout);
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

/// `$CODEX_HOME/worktrees`，或 `config.toml` 里绝对路径的 `desktop.git-worktree-root`。
pub fn codex_worktree_root() -> PathBuf {
    let home = codex_home();
    configured_worktree_root(&home).unwrap_or_else(|| home.join("worktrees"))
}

pub fn configured_worktree_root(codex_home: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(codex_home.join("config.toml")).ok()?;
    let doc = raw.parse::<toml_edit::Document>().ok()?;
    let configured = doc
        .get("desktop")
        .and_then(|item| item.get("git-worktree-root"))
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())?;
    let path = PathBuf::from(configured);
    path.is_absolute().then_some(path)
}

pub fn create_codex_checkout(source: &Path, managed_root: &Path) -> Result<Checkout, String> {
    if !managed_root.is_absolute() {
        return Err("工作树目录必须是绝对路径".into());
    }
    let source = dunce_or_canonicalize(source)?;
    let repo = repository_root(&source)?;
    let repo_name = repo
        .file_name()
        .ok_or_else(|| "仓库没有目录名".to_string())?;
    let sha = git_stdout(
        &repo,
        &["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
    )?;
    fs::create_dir_all(managed_root).map_err(|err| format!("无法创建工作树目录: {err}"))?;
    let bucket = allocate_bucket(managed_root)?;
    let root = bucket.join(repo_name);
    let root_arg = root.to_string_lossy().to_string();
    if let Err(err) = git_status(
        &repo,
        &[
            "worktree",
            "add",
            "--detach",
            "--no-checkout",
            &root_arg,
            &sha,
        ],
    ) {
        let _ = fs::remove_dir(&bucket);
        return Err(err);
    }
    let populated = (|| {
        let config = git_stdout(
            &root,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "config.worktree",
            ],
        )?;
        git_status(
            &root,
            &["config", "--file", &config, "core.worktree", &root_arg],
        )?;
        git_status(
            &root,
            &[
                "--work-tree=.",
                "reset",
                "--hard",
                "--no-recurse-submodules",
                &sha,
            ],
        )?;
        Ok::<(), String>(())
    })();
    if let Err(err) = populated {
        remove_checkout(&repo, &root);
        return Err(err);
    }
    let relative = match relative_checkout(&repo, &source) {
        Ok(path) => path,
        Err(err) => {
            remove_checkout(&repo, &root);
            return Err(err);
        }
    };
    let cwd = root.join(&relative);
    if !cwd.is_dir() {
        remove_checkout(&repo, &root);
        return Err("工作树里没有对应的工作目录".into());
    }
    let cwd = match dunce_or_canonicalize(&cwd) {
        Ok(path) => path,
        Err(err) => {
            remove_checkout(&repo, &root);
            return Err(err);
        }
    };
    let canonical_root = match dunce_or_canonicalize(&root) {
        Ok(path) => path,
        Err(err) => {
            remove_checkout(&repo, &root);
            return Err(err);
        }
    };
    Ok(Checkout {
        cwd,
        root: canonical_root,
        branch: None,
    })
}

pub fn plan_claude_worktree(source: &Path) -> Result<ClaudeWorktreePlan, String> {
    let repo = repository_root(source)?;
    let name = format!("wt-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    Ok(ClaudeWorktreePlan {
        path: repo.join(".claude").join("worktrees").join(&name),
        branch: format!("worktree-{name}"),
        name,
    })
}

/// 创建失败时撤掉半成品。会话结束不调用。
/// Codex 官方在会话结束或删除时怎么清理工作树，本仓库资料里没有确认，标为未观察。
pub fn remove_checkout(source: &Path, checkout_root: &Path) {
    let _suppress = SuppressCancel::enter();
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
                delete_recorded_branch(project, marker.branch.as_deref(), marker.base.as_deref());
                return Ok(true);
            }
        }
        return Err(git_error.unwrap_or_else(|| "工作树没有删掉".into()));
    }
    discard_worktree_directory(project, &checkout, &marker.root);
    if !checkout.root.exists() {
        let _ = git_status(project, &["worktree", "prune"]);
    }
    delete_recorded_branch(project, marker.branch.as_deref(), marker.base.as_deref());
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

fn remove_worktree_tree(path: &Path) {
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
fn remove_empty_worktree_containers(removed: &Path, repo: &Path) {
    let Some(parent) = removed.parent() else {
        return;
    };
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
    Ok(crate::encoding::decode_child_bytes(&output.stdout).into_owned())
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

fn delete_recorded_branch(repo: &Path, branch: Option<&str>, base: Option<&str>) {
    let Some(branch) = branch
        .map(str::trim)
        .filter(|name| name.starts_with("worktree-"))
    else {
        return;
    };
    if base.is_some_and(|name| name == branch) {
        return;
    }
    if branch_name(repo).ok().flatten().as_deref() == Some(branch) {
        return;
    }
    let _ = git_status(repo, &["branch", "-D", branch]);
}

pub(crate) fn read_marker_file(path: &Path) -> Option<OwnedMarker> {
    let raw = fs::read_to_string(path).ok()?;
    parse_marker_json(&raw)
}

fn read_marker(cwd: &Path) -> Option<OwnedMarker> {
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

fn owned_git_file(cwd: &Path, name: &str) -> Result<PathBuf, String> {
    let text = git_stdout(
        cwd,
        &["rev-parse", "--path-format=absolute", "--git-path", name],
    )?;
    Ok(resolve_git_path(cwd, &text))
}

fn head_sha(cwd: &Path) -> Result<String, String> {
    git_stdout(cwd, &["rev-parse", "--verify", "HEAD^{commit}"])
}

fn same_path(left: &Path, right: &Path) -> bool {
    match (dunce_or_canonicalize(left), dunce_or_canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn allocate_bucket(root: &Path) -> Result<PathBuf, String> {
    for _ in 0..64 {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let bucket = root.join(&id[..4]);
        match fs::create_dir(&bucket) {
            Ok(()) => return Ok(bucket),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("无法创建工作树目录: {err}")),
        }
    }
    Err("没有可用的工作树目录".into())
}

fn git_path(cwd: &Path, argument: &str) -> Result<Option<PathBuf>, String> {
    let output = match git_output(cwd, &["rev-parse", "--path-format=absolute", argument]) {
        Ok(output) => output,
        Err(err) if err.contains("无法运行 git") || err == "已停止" => return Err(err),
        Err(_) => return Ok(None),
    };
    if !output.status.success() {
        let stderr = crate::encoding::decode_child_bytes(&output.stderr);
        if stderr.contains("not a git repository") || stderr.trim().is_empty() {
            return Ok(None);
        }
        return Ok(None);
    }
    let text = crate::encoding::decode_child_bytes(&output.stdout);
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
    let text = crate::models::strip_verbatim_prefix(&path.to_string_lossy());
    text.replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

fn resolve_git_path(cwd: &Path, text: &str) -> PathBuf {
    let text = crate::models::strip_verbatim_prefix(text.trim().trim_matches('"'));
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

fn branch_name(cwd: &Path) -> Result<Option<String>, String> {
    let output = git_output(cwd, &["branch", "--show-current"])?;
    if !output.status.success() {
        let stderr = crate::encoding::decode_child_bytes(&output.stderr);
        let stderr = stderr.trim();
        if stderr.contains("not a git repository") {
            return Ok(None);
        }
        if stderr.is_empty() {
            return Err("无法读取当前分支".into());
        }
        return Err(stderr.to_string());
    }
    let name = crate::encoding::decode_child_bytes(&output.stdout);
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
        .arg("-c")
        .arg(format!("core.hooksPath={hooks}"))
        .arg("-c")
        .arg("core.fsmonitor=")
        .arg("-c")
        .arg("core.attributesFile=")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    crate::encoding::apply_utf8_env_std(&mut command);
    super::hide_console(&mut command);
    command
}

fn git_output(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    if !root.is_dir() {
        return Err("项目不存在".into());
    }
    #[cfg(test)]
    reject_blocked_git()?;
    if start_cancelled() {
        return Err("已停止".into());
    }
    let mut command = isolated_git(root);
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
    let tracked = note_start_child(child.id());
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_handle = std::thread::spawn(move || read_pipe(stdout));
    let err_handle = std::thread::spawn(move || read_pipe(stderr));
    let started = Instant::now();
    let status = loop {
        if start_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = out_handle.join();
            let _ = err_handle.join();
            drop(tracked);
            return Err("已停止".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > GIT_COMMAND_LIMIT => {
                let _ = child.kill();
                kill_pid(child.id());
                let _ = child.wait();
                let _ = out_handle.join();
                let _ = err_handle.join();
                drop(tracked);
                return Err("等待 git 超时，已停止这次操作。".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
            Err(err) => {
                drop(tracked);
                return Err(format!("无法等待 git: {err}"));
            }
        }
    };
    drop(tracked);
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

fn git_stdout(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_output(cwd, args)?;
    if !output.status.success() {
        return Err(git_failure(&output, "git 失败"));
    }
    let text = crate::encoding::decode_child_bytes(&output.stdout);
    let text = text.trim();
    if text.is_empty() {
        return Err("git 没有输出".into());
    }
    Ok(text.to_string())
}

fn git_status(cwd: &Path, args: &[&str]) -> Result<(), String> {
    let output = git_output(cwd, args)?;
    if output.status.success() {
        return Ok(());
    }
    Err(git_failure(&output, "git 失败"))
}

fn git_failure(output: &std::process::Output, fallback: &str) -> String {
    let stderr = crate::encoding::decode_child_bytes(&output.stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        fallback.to_string()
    } else {
        stderr.to_string()
    }
}

fn dunce_or_canonicalize(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map(|item| {
            let text = item.to_string_lossy();
            PathBuf::from(crate::models::strip_verbatim_prefix(&text))
        })
        .map_err(|err| format!("无法解析路径: {err}"))
}

fn codex_home() -> PathBuf {
    if let Some(dir) = std::env::var_os("CODEX_HOME") {
        let path = PathBuf::from(dir);
        if !path.as_os_str().is_empty() {
            return path;
        }
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        return PathBuf::from(home).join(".codex");
    }
    PathBuf::from(".codex")
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
    fn codex_checkout_is_detached_and_linked() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("codex");
        let managed = scratch("managed");
        let checkout = create_codex_checkout(&repo, &managed).unwrap();
        assert!(checkout.cwd.starts_with(&managed));
        assert_eq!(checkout.branch, None);
        assert_eq!(current_branch(&checkout.cwd).unwrap(), None);
        assert!(checkout.cwd.join("note.txt").is_file());
        let linked = linked_checkout(&repo, &checkout.cwd).unwrap().unwrap();
        assert_eq!(linked.branch, None);
        assert!(linked_checkout(&repo, &repo).unwrap().is_none());

        bind_codex_thread(&checkout.cwd, "thread-1").unwrap();
        bind_codex_thread(&checkout.cwd, "thread-1").unwrap();
        assert!(bind_codex_thread(&checkout.cwd, "other").is_err());

        remove_checkout(&repo, &checkout.root);
        assert!(!checkout.root.exists());
        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(managed);
    }

    #[test]
    fn recorded_marker_is_readable_without_git_and_delete_still_works() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("list-recorded");
        let managed = scratch("list-managed");
        let checkout = create_codex_checkout(&repo, &managed).unwrap();
        let (base, sha) = source_revision(&repo).unwrap();
        record_owned_worktree(
            &checkout.cwd,
            &OwnedMarker {
                root: checkout.root.clone(),
                base: base.clone(),
                sha: sha.clone(),
                branch: None,
            },
        )
        .unwrap();
        let guard = block_git();
        let found = crate::features::git::recorded_checkouts(&repo, &managed);
        assert_eq!(guard.calls(), 0);
        assert_eq!(found.len(), 1, "新建的托管检出应能只靠标记文件认出来");
        assert!(crate::features::git::checkout_matches(
            &found,
            &checkout.cwd.to_string_lossy()
        ));
        assert_eq!(found[0].base.as_deref(), Some("main"));
        assert!(found[0].sha.starts_with(&sha[..7]));
        drop(guard);
        assert!(remove_owned_worktree(&repo, &checkout.cwd, true).unwrap());
        assert!(!checkout.root.exists());
        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(managed);
    }

    #[test]
    fn claude_plan_uses_the_documented_directory_and_branch() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("claude");
        let nested = repo.join("src");
        fs::create_dir_all(&nested).unwrap();
        let plan = plan_claude_worktree(&nested).unwrap();
        assert!(plan
            .path
            .starts_with(repo.join(".claude").join("worktrees")));
        assert!(plan.name.starts_with("wt-"));
        assert_eq!(plan.branch, format!("worktree-{}", plan.name));
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn desktop_root_must_be_absolute() {
        let home = scratch("home");
        let absolute = if cfg!(windows) {
            "C:/codex-worktrees"
        } else {
            "/var/codex-worktrees"
        };
        fs::write(
            home.join("config.toml"),
            format!("[desktop]\ngit-worktree-root = \"{absolute}\"\n"),
        )
        .unwrap();
        assert_eq!(
            configured_worktree_root(&home).unwrap(),
            PathBuf::from(absolute)
        );
        fs::write(
            home.join("config.toml"),
            "[desktop]\ngit-worktree-root = \"relative\"\n",
        )
        .unwrap();
        assert!(configured_worktree_root(&home).is_none());
        let _ = fs::remove_dir_all(home);
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
        let checkout = create_codex_checkout(&repo, &managed).unwrap();
        record_owned_worktree(
            &checkout.cwd,
            &OwnedMarker {
                root: checkout.root.clone(),
                base: base.clone(),
                sha: sha.clone(),
                branch: None,
            },
        )
        .unwrap();
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

    #[test]
    fn codex_bucket_is_removed_with_the_worktree() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("codex-bucket");
        let managed = scratch("codex-bucket-root");
        let checkout = create_codex_checkout(&repo, &managed).unwrap();
        let (base, sha) = source_revision(&repo).unwrap();
        record_owned_worktree(
            &checkout.cwd,
            &OwnedMarker {
                root: checkout.root.clone(),
                base,
                sha,
                branch: None,
            },
        )
        .unwrap();
        let bucket = checkout.root.parent().unwrap().to_path_buf();
        assert!(remove_owned_worktree(&repo, &checkout.cwd, true).unwrap());
        assert!(!checkout.root.exists(), "Codex 工作树目录应被清掉");
        assert!(!bucket.exists(), "空的四位目录应被清掉");
        assert!(managed.is_dir(), "托管根要留着");
        assert!(repo.join("note.txt").is_file());
        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(managed);
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
        let checkout = create_codex_checkout(&repo, &managed).unwrap();
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "checkout waited on a hook or fsmonitor"
        );
        assert!(checkout.cwd.join("note.txt").is_file());
        assert!(!hook_ran.exists(), "post-checkout hook ran");
        assert!(!monitor_ran.exists(), "fsmonitor ran");
        let (base, sha) = source_revision(&repo).unwrap();
        record_owned_worktree(
            &checkout.cwd,
            &OwnedMarker {
                root: checkout.root.clone(),
                base,
                sha,
                branch: None,
            },
        )
        .unwrap();
        assert!(session_worktree(&repo, &checkout.cwd).unwrap().owned);
        remove_checkout(&repo, &checkout.root);
        assert!(!checkout.root.exists());
        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(managed);
        let _ = fs::remove_dir_all(mark);
    }

    #[test]
    fn cancel_before_begin_rejects_the_start() {
        let id = unique_start("early");
        cancel_worktree_start(&id);
        match WorktreeStart::begin(&id) {
            Err(err) => assert_eq!(err, "已停止"),
            Ok(_) => panic!("取消之后不应该再开始"),
        }
    }

    #[test]
    fn cancel_kills_the_in_flight_start_process() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let id = unique_start("kill");
            let startup = WorktreeStart::begin(&id).unwrap();
            startup
                .drive(async {
                    let mut child = long_sleep()
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .unwrap();
                    let _tracked = note_start_child(child.id());
                    let project = id.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(40));
                        cancel_worktree_start(&project);
                    });
                    let started = std::time::Instant::now();
                    let status = child.wait().unwrap();
                    assert!(
                        started.elapsed() < Duration::from_secs(5),
                        "stop did not kill the child"
                    );
                    assert!(!status.success());
                })
                .await;
        });
    }

    fn relative_checkout(root: &Path, source: &Path) -> Result<PathBuf, String> {
        super::relative_checkout(root, source)
    }

    fn resolve_git_path(cwd: &Path, text: &str) -> PathBuf {
        super::resolve_git_path(cwd, text)
    }

    fn long_sleep() -> Command {
        if cfg!(windows) {
            let mut command = Command::new("ping");
            command.args(["-n", "31", "127.0.0.1"]);
            command
        } else {
            let mut command = Command::new("sleep");
            command.arg("30");
            command
        }
    }

    fn unique_start(name: &str) -> String {
        format!(
            "{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
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
