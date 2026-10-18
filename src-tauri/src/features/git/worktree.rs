//! 新建会话用的 Git 工作树。
//!
//! Codex 的布局对齐 `openai/codex` `codex-rs/worktree`（2026-10-18 main）：
//! 在托管根目录下建 `{4位十六进制}/{仓库名}`，`git worktree add --detach`，
//! 再 `reset --hard`。CLI 的 `WorktreeSettings::for_cli` 关闭自动清理。
//! app-server 的 `thread/start` 只收 `cwd`，没有创建工作树的 RPC。
//!
//! Claude Code 的 `--worktree <name>` 把工作树放在仓库 `.claude/worktrees/<name>`，
//! 分支名是 `worktree-<name>`。这里只算出路径和名字，由适配器把旗标交给 CLI。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use super::{current_branch, git_output};

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
    let branch = current_branch(cwd)?;
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
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            "HEAD^{commit}",
        ],
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
            &[
                "config",
                "--file",
                &config,
                "core.worktree",
                &root_arg,
            ],
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
    let relative = source
        .strip_prefix(&repo)
        .map_err(|_| "工作目录不在仓库里".to_string())?;
    let cwd = root.join(relative);
    if !cwd.is_dir() {
        remove_checkout(&repo, &root);
        return Err("工作树里没有对应的工作目录".into());
    }
    Ok(Checkout {
        cwd: dunce_or_canonicalize(&cwd)?,
        root: dunce_or_canonicalize(&root)?,
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
    let root_arg = checkout_root.to_string_lossy().to_string();
    let _ = git_status(source, &["worktree", "remove", "--force", &root_arg]);
    if let Ok(repo) = repository_root(source) {
        let _ = git_status(&repo, &["worktree", "remove", "--force", &root_arg]);
    }
    let _ = fs::remove_dir_all(checkout_root);
    if let Some(bucket) = checkout_root.parent() {
        let _ = fs::remove_dir(bucket);
    }
}

/// `codex-thread.json`，版本 1，字段 `ownerThreadId`。已有同一线程时保持原文件。
pub fn bind_codex_thread(cwd: &Path, thread_id: &str) -> Result<(), String> {
    let thread_id = thread_id.trim();
    if thread_id.is_empty() {
        return Err("没有线程 id".into());
    }
    let relative = git_stdout(cwd, &["rev-parse", "--git-path", "codex-thread.json"])?;
    let path = cwd.join(relative);
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

const MARKER_NAME: &str = "ai-workbench-worktree.json";

/// 源目录当时的分支和提交。分离头指针没有分支名。
pub fn source_revision(source: &Path) -> Result<(Option<String>, String), String> {
    let base = current_branch(source)?;
    let sha = git_stdout(
        source,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            "HEAD^{commit}",
        ],
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
        return DeletePreview { owned: false, dirty: false };
    };
    if !info.owned {
        return DeletePreview { owned: false, dirty: false };
    }
    let dirty = worktree_is_dirty(&info.cwd, info.base.as_deref(), project);
    DeletePreview { owned: true, dirty }
}

/// 只删除带记录、且不是主检出的链接工作树。`force` 用于用户确认过未保存改动。
/// 返回 false 表示这份目录不是工作台的工作树，什么都没动。
pub fn remove_owned_worktree(project: &Path, cwd: &Path, force: bool) -> Result<bool, String> {
    let Some(checkout) = linked_checkout(project, cwd).ok().flatten() else {
        return Ok(false);
    };
    if points_at_main(project, &checkout) {
        return Ok(false);
    }
    let Some(marker) = read_marker(&checkout.cwd).filter(|item| same_path(&item.root, &checkout.root)) else {
        return Ok(false);
    };
    let root_arg = checkout.root.to_string_lossy().to_string();
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&root_arg);
    git_status(project, &args)?;
    if checkout.root.exists() {
        if let Ok(repo) = repository_root(project) {
            let _ = git_status(&repo, &args);
        }
    }
    if checkout.root.exists() {
        return Err("工作树没有删掉".into());
    }
    if let Some(parent) = checkout.root.parent() {
        let _ = fs::remove_dir(parent);
    }
    delete_recorded_branch(project, marker.branch.as_deref(), marker.base.as_deref());
    Ok(true)
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
    let Some(branch) = branch.map(str::trim).filter(|name| name.starts_with("worktree-")) else {
        return;
    };
    if base.is_some_and(|name| name == branch) {
        return;
    }
    if current_branch(repo).ok().flatten().as_deref() == Some(branch) {
        return;
    }
    let _ = git_status(repo, &["branch", "-D", branch]);
}

fn read_marker(cwd: &Path) -> Option<OwnedMarker> {
    let path = marker_path(cwd).ok()?;
    let raw = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if value.get("version").and_then(|item| item.as_u64()) != Some(1) {
        return None;
    }
    let sha = value.get("sha").and_then(|item| item.as_str())?.trim().to_string();
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
    Some(OwnedMarker { root, base, sha, branch })
}

fn marker_path(cwd: &Path) -> Result<PathBuf, String> {
    let relative = git_stdout(
        cwd,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            MARKER_NAME,
        ],
    )?;
    Ok(PathBuf::from(relative))
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
    let output = match git_output(
        cwd,
        &["rev-parse", "--path-format=absolute", argument],
    ) {
        Ok(output) => output,
        Err(err) if err.contains("无法运行 git") => return Err(err),
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
    let path = PathBuf::from(text.trim());
    if path.as_os_str().is_empty() {
        return Ok(None);
    }
    Ok(Some(dunce_or_canonicalize(&path).unwrap_or(path)))
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
    fn claude_plan_uses_the_documented_directory_and_branch() {
        if !git_ok() {
            return;
        }
        let repo = repo_with_commit("claude");
        let nested = repo.join("src");
        fs::create_dir_all(&nested).unwrap();
        let plan = plan_claude_worktree(&nested).unwrap();
        assert!(plan.path.starts_with(repo.join(".claude").join("worktrees")));
        assert!(plan.name.starts_with("wt-"));
        assert_eq!(plan.branch, format!("worktree-{}", plan.name));
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn desktop_root_must_be_absolute() {
        let home = scratch("home");
        fs::write(
            home.join("config.toml"),
            "[desktop]\ngit-worktree-root = \"/var/codex-worktrees\"\n",
        )
        .unwrap();
        assert_eq!(
            configured_worktree_root(&home).unwrap(),
            PathBuf::from("/var/codex-worktrees")
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
        assert_eq!(delete_preview(&repo, &checkout.cwd), DeletePreview { owned: true, dirty: false });
        assert!(!remove_owned_worktree(&repo, &repo, true).unwrap());
        assert!(repo.join("note.txt").is_file());

        fs::write(checkout.cwd.join("extra.txt"), "dirty\n").unwrap();
        assert!(delete_preview(&repo, &checkout.cwd).dirty);
        assert!(remove_owned_worktree(&repo, &checkout.cwd, false).is_err());
        assert!(checkout.root.exists());

        run_git(&checkout.cwd, &["add", "extra.txt"]);
        run_git(&checkout.cwd, &["-c", "commit.gpgsign=false", "commit", "-m", "wip"]);
        assert!(delete_preview(&repo, &checkout.cwd).dirty);
        fs::write(checkout.cwd.join("extra.txt"), "dirty again\n").unwrap();
        assert!(delete_preview(&repo, &checkout.cwd).dirty);

        run_git(&checkout.cwd, &["reset", "--hard", &sha]);
        assert!(!delete_preview(&repo, &checkout.cwd).dirty);
        assert!(remove_owned_worktree(&repo, &checkout.cwd, false).unwrap());
        assert!(!checkout.root.exists());

        let manual = scratch("manual");
        run_git(&repo, &["worktree", "add", "-b", "hand-made", manual.to_str().unwrap()]);
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
        run_git(&repo, &["worktree", "add", "-b", "worktree-wt-abc12345", path.to_str().unwrap()]);
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
}
