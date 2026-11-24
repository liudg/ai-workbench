//! 逐轮 Git 隐藏引用检查点（`refs/aiwb/checkpoints/<session>/<id>`）捕获、比对与完整还原。

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::path::Path;

use aiwb_core::models::{cwd_key, sanitize_id_segment};
use serde::{Deserialize, Serialize};

use crate::worktree::{
    branch_name, git_output, git_status, git_status_env, git_stdout, git_stdout_env, head_sha,
    owned_git_file, repo_has_commit, repository_root, same_path, user_git_status,
};

pub(crate) const CHECKPOINT_REF_PREFIX: &str = "refs/aiwb/checkpoints/";
const CHECKPOINT_META_PREFIX: &str = "AIWB-Meta: ";
const CHECKPOINT_META_VERSION: u8 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedCheckpoint {
    pub reference: String,
    pub head_oid: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointMeta {
    v: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    head_oid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    index_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    preserved_dirs: Vec<String>,
}

pub(crate) struct WorktreeTrees {
    pub(crate) worktree_tree: String,
    pub(crate) index_tree: Option<String>,
    pub(crate) unborn_nested_dirs: Vec<String>,
}

fn dir_has_entries(dir: &Path) -> bool {
    fs::read_dir(dir)
        .ok()
        .and_then(|mut it| it.next())
        .is_some()
}

fn is_git_ignored(root: &Path, rel: &str) -> bool {
    git_status(root, &["check-ignore", "-q", "--no-index", "--", rel]).is_ok()
}

fn collect_nested_git_under_dir(root: &Path, dir: &Path, rel_prefix: &str, out: &mut Vec<String>) {
    if dir.join(".git").exists() {
        if !is_git_ignored(root, rel_prefix) {
            out.push(rel_prefix.to_string());
        }
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == ".git" {
            continue;
        }
        let child_rel = format!("{rel_prefix}/{name_str}");
        if !is_git_ignored(root, &child_rel) {
            collect_nested_git_under_dir(root, &entry.path(), &child_rel, out);
        }
    }
}

fn scan_nested_git_dirs(root: &Path, include_populated_gitlinks: bool) -> Vec<String> {
    let mut dirs: Vec<String> = Vec::new();

    // 1. 未跟踪且未被 `.gitignore` 忽略的嵌套 `.git` 目录。
    if let Ok(output) = git_output(root, &["ls-files", "--others", "--exclude-standard", "-z"]) {
        if output.status.success() {
            dirs.extend(
                aiwb_proc::decode_child_bytes(&output.stdout)
                    .split('\0')
                    .filter(|entry| entry.ends_with('/'))
                    .map(|entry| entry.trim_end_matches('/'))
                    .filter(|rel| !rel.is_empty() && root.join(rel).join(".git").exists())
                    .map(str::to_string),
            );
        }
    }

    // 2. 暂存区中的 `160000` 嵌套仓库条目（如 `git add inner` 或已初始化的子模块），
    //    以及已跟踪路径的祖先目录被就地 `git init` 成嵌套仓库的情形。
    if let Ok(output) = git_output(root, &["ls-files", "--stage", "-z"]) {
        if output.status.success() {
            let mut checked_ancestors: HashSet<String> = HashSet::new();
            for record in aiwb_proc::decode_child_bytes(&output.stdout).split('\0') {
                let Some((meta, path)) = record.split_once('\t') else {
                    continue;
                };
                if path.is_empty() {
                    continue;
                }
                if meta.starts_with("160000 ") {
                    let full = root.join(path);
                    if full.join(".git").exists()
                        || (include_populated_gitlinks && dir_has_entries(&full))
                    {
                        dirs.push(path.to_string());
                    }
                }
                let mut rest = path;
                while let Some((parent, _)) = rest.rsplit_once('/') {
                    rest = parent;
                    if !parent.is_empty()
                        && checked_ancestors.insert(parent.to_string())
                        && root.join(parent).join(".git").exists()
                    {
                        dirs.push(parent.to_string());
                    }
                }
            }
        }
    }

    // 3. 索引中原本是普通文件，但在磁盘上未 `git rm` 就被替换成嵌套仓库目录的情形。
    if let Ok(output) = git_output(root, &["diff-files", "--name-only", "-z"]) {
        if output.status.success() {
            for rel in aiwb_proc::decode_child_bytes(&output.stdout)
                .split('\0')
                .filter(|s| !s.is_empty())
            {
                let full = root.join(rel);
                if full.is_dir() {
                    collect_nested_git_under_dir(root, &full, rel, &mut dirs);
                }
            }
        }
    }

    let mut normalized: Vec<String> = dirs
        .into_iter()
        .map(|d| d.replace('\\', "/").trim_matches('/').to_string())
        .filter(|d| !d.is_empty())
        .collect();
    normalized.sort();
    normalized.dedup();
    normalized
}

/// 找出工作区里所有现存且未被 `.gitignore` 忽略的嵌套 `.git` 目录（含未跟踪、已 `git add` 为 `160000` 及 D/F 替换目录）。
pub(crate) fn nested_git_dirs(root: &Path) -> Vec<String> {
    scan_nested_git_dirs(root, false)
}

/// 找出工作树里所有外层树快照无法完整保存的嵌套 Git 仓库或非空 `160000` 子模块目录。
pub(crate) fn unsnapshottable_nested_git_dirs(root: &Path) -> Vec<String> {
    scan_nested_git_dirs(root, true)
}

/// 找出工作区里尚未产生提交的嵌套 `.git` 目录（例如 `cargo new sub` / `git init sub`）：
/// 直接 `git add -A` 遇到 unborn 嵌套仓库会以 exit 128 失败，需在暂存时显式 `:(exclude,literal)`，
/// 并在还原清理时跳过检查点捕获前就已存在的嵌套仓库目录。
fn unborn_nested_git_dirs(root: &Path) -> Vec<String> {
    nested_git_dirs(root)
        .into_iter()
        .filter(|rel| !repo_has_commit(&root.join(rel)).unwrap_or(false))
        .collect()
}

fn has_unmerged_index_entries(root: &Path) -> Result<bool, String> {
    let output = git_output(root, &["ls-files", "--unmerged", "-z"])?;
    if !output.status.success() {
        return Err("无法检查 Git 暂存区冲突状态".into());
    }
    Ok(!output.stdout.is_empty())
}

pub(crate) fn in_progress_git_operation_at_root(root: &Path) -> Result<Option<&'static str>, String> {
    if has_unmerged_index_entries(root)? {
        return Ok(Some("未解决的合并冲突"));
    }
    if owned_git_file(root, "MERGE_HEAD").is_ok_and(|p| p.exists()) {
        return Ok(Some("正在进行的合并（MERGE_HEAD）"));
    }
    if owned_git_file(root, "rebase-merge").is_ok_and(|p| p.exists())
        || owned_git_file(root, "rebase-apply").is_ok_and(|p| p.exists())
    {
        return Ok(Some("正在进行的变基（rebase）"));
    }
    if owned_git_file(root, "CHERRY_PICK_HEAD").is_ok_and(|p| p.exists()) {
        return Ok(Some("正在进行的拣选（cherry-pick）"));
    }
    if owned_git_file(root, "REVERT_HEAD").is_ok_and(|p| p.exists()) {
        return Ok(Some("正在进行的还原提交（revert）"));
    }
    Ok(None)
}

/// 检查 `cwd` 所属检出是否处于未解决冲突或进行中的多步 Git 操作（merge / rebase / cherry-pick / revert）。
pub fn in_progress_git_operation(cwd: &Path) -> Result<Option<&'static str>, String> {
    if !cwd.is_dir() {
        return Ok(None);
    }
    let Ok(root) = repository_root(cwd) else {
        return Ok(None);
    };
    in_progress_git_operation_at_root(&root)
}

fn add_all_args_with_excludes(excludes: &[String]) -> Vec<String> {
    let mut args = vec![
        "-c".to_string(),
        "core.splitIndex=false".to_string(),
        "add".to_string(),
        "-A".to_string(),
        "--".to_string(),
        ".".to_string(),
    ];
    for rel in excludes {
        args.push(format!(":(exclude,literal){rel}"));
    }
    args
}

/// 构造 `git clean -e <pattern>` 所需的根锚定目录排除规则，转义 gitignore 通配元字符。
fn clean_exclude_pattern(rel: &str) -> String {
    let normalized = rel.replace('\\', "/");
    let trimmed = normalized.trim_matches('/');
    let mut escaped = String::with_capacity(trimmed.len() + 2);
    escaped.push('/');
    for ch in trimmed.chars() {
        if matches!(ch, '\\' | '*' | '?' | '[' | ']') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped.push('/');
    escaped
}

fn clean_args_with_preserved(preserved_dirs: &[String], clean_nested_repos: bool) -> Vec<String> {
    let mut args = vec![
        "clean".to_string(),
        if clean_nested_repos { "-ffd" } else { "-fd" }.to_string(),
        "-q".to_string(),
    ];
    for rel in preserved_dirs {
        let trimmed = rel.trim_matches('/');
        if trimmed.is_empty() {
            continue;
        }
        args.push("-e".to_string());
        args.push(clean_exclude_pattern(trimmed));
    }
    args
}

pub(crate) fn git_bot_env() -> [(&'static str, &'static OsStr); 4] {
    [
        ("GIT_AUTHOR_NAME", OsStr::new("AI Workbench")),
        ("GIT_AUTHOR_EMAIL", OsStr::new("aiwb@localhost")),
        ("GIT_COMMITTER_NAME", OsStr::new("AI Workbench")),
        ("GIT_COMMITTER_EMAIL", OsStr::new("aiwb@localhost")),
    ]
}

fn read_checkpoint_meta(root: &Path, commit_oid: &str) -> Option<CheckpointMeta> {
    let body = git_stdout(root, &["show", "-s", "--format=%B", commit_oid]).ok()?;
    for line in body.lines().rev() {
        if let Some(json_str) = line.trim().strip_prefix(CHECKPOINT_META_PREFIX) {
            if let Ok(mut meta) = serde_json::from_str::<CheckpointMeta>(json_str) {
                meta.preserved_dirs.sort();
                meta.preserved_dirs.dedup();
                return Some(meta);
            }
        }
    }
    None
}

/// 用独立临时 index 分别写出当前暂存区树（`index_tree`）与工作区全量树（`worktree_tree`）。
/// `require_index_tree` 为 `true` 时，若暂存区含未合并冲突导致 `write-tree` 失败会直接报错而不是降级忽略。
pub(crate) fn write_worktree_and_index_trees(
    root: &Path,
    head_oid: Option<&str>,
    require_index_tree: bool,
) -> Result<WorktreeTrees, String> {
    let temp_id = uuid::Uuid::new_v4().simple().to_string();
    let index = owned_git_file(root, &format!("aiwb-worktree-{temp_id}.index"))?;
    let lock = owned_git_file(root, &format!("aiwb-worktree-{temp_id}.index.lock"))?;
    let _ = fs::remove_file(&index);
    let _ = fs::remove_file(&lock);

    let real = owned_git_file(root, "index").ok().filter(|p| p.is_file());
    let seeded = real.is_some_and(|src| fs::copy(&src, &index).is_ok());
    let index_env = [("GIT_INDEX_FILE", index.as_os_str())];
    let excludes = unborn_nested_git_dirs(root);
    let add_args = add_all_args_with_excludes(&excludes);
    let add_refs: Vec<&str> = add_args.iter().map(String::as_str).collect();

    let result = (|| {
        if !seeded {
            if let Some(head) = head_oid {
                git_status_env(
                    root,
                    &["-c", "core.splitIndex=false", "read-tree", head],
                    &index_env,
                )?;
            } else {
                git_status_env(
                    root,
                    &["-c", "core.splitIndex=false", "read-tree", "--empty"],
                    &index_env,
                )?;
            }
        }
        // 在 `git add -A` 覆写临时索引之前，先拍下用户真实暂存区的树对象。
        let index_tree = if require_index_tree {
            Some(git_stdout_env(
                root,
                &["-c", "core.splitIndex=false", "write-tree"],
                &index_env,
            )?)
        } else {
            None
        };
        if !excludes.is_empty() {
            let mut rm_args = vec![
                "-c".to_string(),
                "core.splitIndex=false".to_string(),
                "rm".to_string(),
                "-r".to_string(),
                "-f".to_string(),
                "-q".to_string(),
                "--cached".to_string(),
                "--ignore-unmatch".to_string(),
                "--".to_string(),
            ];
            rm_args.extend(excludes.iter().cloned());
            let rm_refs: Vec<&str> = rm_args.iter().map(String::as_str).collect();
            let _ = git_status_env(root, &rm_refs, &index_env);
        }
        git_status_env(root, &add_refs, &index_env)?;
        let worktree_tree = git_stdout_env(
            root,
            &["-c", "core.splitIndex=false", "write-tree"],
            &index_env,
        )?;
        Ok(WorktreeTrees {
            worktree_tree,
            index_tree,
            unborn_nested_dirs: excludes,
        })
    })();

    let _ = fs::remove_file(&index);
    let _ = fs::remove_file(&lock);
    result
}

/// 用独立临时 index 将当前工作区全量状态（含已暂存、未暂存与非忽略未跟踪文件）写成隐藏提交树。
pub(crate) fn write_worktree_tree(root: &Path, head_oid: Option<&str>) -> Result<String, String> {
    Ok(write_worktree_and_index_trees(root, head_oid, false)?.worktree_tree)
}

/// 用临时 index 将工作区写成独立 commit 对象（返回 `commit_oid`），供工作树休眠快照使用。
pub(crate) fn commit_worktree_tree(
    root: &Path,
    head_oid: Option<&str>,
    message: &str,
) -> Result<String, String> {
    let tree_oid = write_worktree_tree(root, head_oid)?;
    let who = git_bot_env();
    match head_oid {
        Some(head) => git_stdout_env(
            root,
            &["commit-tree", &tree_oid, "-p", head, "-m", message],
            &who,
        ),
        None => git_stdout_env(root, &["commit-tree", &tree_oid, "-m", message], &who),
    }
}

/// 检查 `branch_ref`（如 `refs/heads/main`）是否正被当前仓库的**其它**工作树检出。
fn branch_checked_out_elsewhere(root: &Path, branch_ref: &str) -> bool {
    let Ok(output) = git_output(root, &["worktree", "list", "--porcelain", "-z"]) else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let root_key = cwd_key(&root.to_string_lossy());
    let decoded = aiwb_proc::decode_child_bytes(&output.stdout);
    let mut current_wt: Option<&str> = None;
    for field in decoded.split('\0') {
        if field.is_empty() {
            current_wt = None;
            continue;
        }
        if let Some(wt) = field.strip_prefix("worktree ") {
            current_wt = Some(wt);
        } else if let Some(b_ref) = field.strip_prefix("branch ") {
            if b_ref == branch_ref {
                if let Some(wt) = current_wt {
                    let same = same_path(Path::new(wt), root) || cwd_key(wt) == root_key;
                    if !same {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// 在 `cwd` 所属 Git 检出上捕获一次检查点，挂在 `refs/aiwb/checkpoints/<session_id>/<checkpoint_id>-<suffix>`。
/// 同时记录暂存区树（挂为父提交以防 GC 回收）、`HEAD`、分支与检查点前已存在的 unborn 嵌套仓库列表。
/// 若 `cwd` 不在 Git 仓库内，返回 `Ok(None)`。
pub fn capture_checkpoint(
    cwd: &Path,
    session_id: &str,
    checkpoint_id: &str,
    suffix: &str,
) -> Result<Option<CapturedCheckpoint>, String> {
    if !cwd.is_dir() {
        return Ok(None);
    }
    let Ok(root) = repository_root(cwd) else {
        return Ok(None);
    };
    if let Some(op) = in_progress_git_operation_at_root(&root)? {
        return Err(format!("仓库当前存在{op}，无法安全保存检查点"));
    }
    let has_commit = repo_has_commit(&root)?;
    let head_oid = if has_commit {
        Some(head_sha(&root)?)
    } else {
        None
    };
    let branch = branch_name(&root)?;
    let trees = write_worktree_and_index_trees(&root, head_oid.as_deref(), true)?;
    let who = git_bot_env();

    let index_commit = match trees.index_tree.as_deref() {
        Some(index_tree) => {
            let oid = match head_oid.as_deref() {
                Some(head) => git_stdout_env(
                    &root,
                    &[
                        "commit-tree",
                        index_tree,
                        "-p",
                        head,
                        "-m",
                        "AI Workbench checkpoint index",
                    ],
                    &who,
                )?,
                None => git_stdout_env(
                    &root,
                    &["commit-tree", index_tree, "-m", "AI Workbench checkpoint index"],
                    &who,
                )?,
            };
            Some(oid)
        }
        None => None,
    };

    let meta = CheckpointMeta {
        v: CHECKPOINT_META_VERSION,
        head_oid: head_oid.clone(),
        branch: branch.clone(),
        index_commit: index_commit.clone(),
        preserved_dirs: trees.unborn_nested_dirs,
    };
    let meta_json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    let message = format!("AI Workbench checkpoint\n\n{CHECKPOINT_META_PREFIX}{meta_json}");

    let mut commit_args = vec!["commit-tree", trees.worktree_tree.as_str()];
    if let Some(head) = head_oid.as_deref() {
        commit_args.push("-p");
        commit_args.push(head);
    }
    if let Some(idx_commit) = index_commit.as_deref() {
        commit_args.push("-p");
        commit_args.push(idx_commit);
    }
    commit_args.push("-m");
    commit_args.push(&message);
    let commit_oid = git_stdout_env(&root, &commit_args, &who)?;

    let safe_session = sanitize_id_segment(session_id, "item");
    let safe_cp = sanitize_id_segment(checkpoint_id, "item");
    let safe_suffix = sanitize_id_segment(suffix, "item");
    let reference = format!("{CHECKPOINT_REF_PREFIX}{safe_session}/{safe_cp}-{safe_suffix}");
    git_status(&root, &["update-ref", &reference, &commit_oid])?;

    Ok(Some(CapturedCheckpoint {
        reference,
        head_oid,
        branch,
    }))
}

/// 检查引用是否仍存在于仓库中。
pub fn has_checkpoint_ref(cwd: &Path, reference: &str) -> bool {
    if !reference.starts_with(CHECKPOINT_REF_PREFIX) || !cwd.is_dir() {
        return false;
    }
    let Ok(root) = repository_root(cwd) else {
        return false;
    };
    git_stdout(&root, &["rev-parse", "--verify", "--quiet", &format!("{reference}^{{commit}}")])
        .is_ok()
}

/// 判断当前检出相对指定检查点引用是否有变动（包括工作区内容、暂存区、HEAD 提交、分支及 unborn 嵌套仓库）。
pub fn has_working_tree_changed_since(cwd: &Path, reference: &str) -> Result<bool, String> {
    let root = repository_root(cwd)?;
    if in_progress_git_operation_at_root(&root)?.is_some() {
        return Ok(true);
    }
    let commit_oid = git_stdout(
        &root,
        &["rev-parse", "--verify", &format!("{reference}^{{commit}}")],
    )?;
    let meta = read_checkpoint_meta(&root, &commit_oid);

    let current_head_oid = if repo_has_commit(&root)? {
        Some(head_sha(&root)?)
    } else {
        None
    };
    let current_branch = branch_name(&root)?;

    match &meta {
        Some(m) => {
            if current_head_oid != m.head_oid || current_branch != m.branch {
                return Ok(true);
            }
        }
        None => {
            // 兼容旧版未写 AIWB-Meta 的检查点：父提交 ^1 即捕获时的 HEAD（空仓库无父提交）。
            let expected_head = git_stdout(
                &root,
                &["rev-parse", "--verify", "--quiet", &format!("{commit_oid}^1")],
            )
            .ok();
            if current_head_oid != expected_head {
                return Ok(true);
            }
        }
    }

    let need_index_tree = meta.as_ref().and_then(|m| m.index_commit.as_deref()).is_some();
    let current_trees =
        write_worktree_and_index_trees(&root, current_head_oid.as_deref(), need_index_tree)?;
    let expected_preserved: &[String] = meta
        .as_ref()
        .map(|m| m.preserved_dirs.as_slice())
        .unwrap_or(&[]);
    if current_trees.unborn_nested_dirs != expected_preserved {
        return Ok(true);
    }

    let expected_worktree_tree = git_stdout(
        &root,
        &["rev-parse", "--verify", &format!("{commit_oid}^{{tree}}")],
    )?;
    if current_trees.worktree_tree != expected_worktree_tree {
        return Ok(true);
    }

    if let Some(index_commit) = meta.as_ref().and_then(|m| m.index_commit.as_deref()) {
        let expected_index_tree = git_stdout(
            &root,
            &["rev-parse", "--verify", &format!("{index_commit}^{{tree}}")],
        )?;
        if current_trees.index_tree.as_deref() != Some(expected_index_tree.as_str()) {
            return Ok(true);
        }
    }

    Ok(false)
}

fn paths_conflict(tree_entry: &str, preserved_dir: &str) -> bool {
    tree_entry == preserved_dir
        || tree_entry
            .strip_prefix(preserved_dir)
            .is_some_and(|rest| rest.starts_with('/'))
        || preserved_dir
            .strip_prefix(tree_entry)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn checkpoint_restore_conflict_at_root(
    root: &Path,
    commit_oid: &str,
    preserved_dirs: &[String],
) -> Result<Option<String>, String> {
    let cleaned: Vec<String> = preserved_dirs
        .iter()
        .map(|d| d.replace('\\', "/").trim_matches('/').to_string())
        .filter(|d| !d.is_empty())
        .collect();
    if cleaned.is_empty() {
        return Ok(None);
    }
    let output = git_output(root, &["ls-tree", "-r", "--name-only", "-z", commit_oid])?;
    if !output.status.success() {
        return Err("无法读取检查点文件树".into());
    }
    let decoded = aiwb_proc::decode_child_bytes(&output.stdout);
    let entries: Vec<&str> = decoded.split('\0').filter(|s| !s.is_empty()).collect();
    let mut conflicts: Vec<String> = cleaned
        .into_iter()
        .filter(|dir| entries.iter().any(|entry| paths_conflict(entry, dir)))
        .collect();
    conflicts.sort();
    conflicts.dedup();
    if conflicts.is_empty() {
        Ok(None)
    } else {
        Ok(Some(format!(
            "现存嵌套 Git 仓库（{}）与检查点中的文件路径冲突，无法覆盖还原以避免丢失仓库数据",
            conflicts.join("、")
        )))
    }
}

/// 检查还原指定检查点是否会与必须保留的现存嵌套 Git 仓库产生路径覆盖冲突。
pub fn checkpoint_restore_conflict(cwd: &Path, reference: &str) -> Result<Option<String>, String> {
    if !reference.starts_with(CHECKPOINT_REF_PREFIX) || !cwd.is_dir() {
        return Ok(None);
    }
    let Ok(root) = repository_root(cwd) else {
        return Ok(None);
    };
    let Ok(commit_oid) = git_stdout(
        &root,
        &["rev-parse", "--verify", "--quiet", &format!("{reference}^{{commit}}")],
    ) else {
        return Ok(None);
    };
    let meta = read_checkpoint_meta(&root, &commit_oid);
    let preserved_dirs = match &meta {
        Some(m) => m.preserved_dirs.clone(),
        None => nested_git_dirs(&root),
    };
    checkpoint_restore_conflict_at_root(&root, &commit_oid, &preserved_dirs)
}

/// 将检出的 `HEAD`、分支指针、暂存区、已跟踪文件以及新增的未跟踪文件完整还原到检查点时刻，
/// 同时保留 `.gitignore` 忽略的构建产物（如 `node_modules`、`target`）与检查点前已存在的嵌套 Git 仓库。
pub fn restore_checkpoint(
    cwd: &Path,
    reference: &str,
    head_oid: Option<&str>,
    branch: Option<&str>,
) -> Result<(), String> {
    if !reference.starts_with(CHECKPOINT_REF_PREFIX) {
        return Err("非法的检查点引用".into());
    }
    let root = repository_root(cwd)?;
    let commit_oid = git_stdout(
        &root,
        &["rev-parse", "--verify", &format!("{reference}^{{commit}}")],
    )
    .map_err(|_| "找不到对应的检查点快照，无法还原文件".to_string())?;
    if let Some(op) = in_progress_git_operation_at_root(&root)? {
        return Err(format!("仓库当前存在{op}，请先完成或中止该 Git 操作后再回退文件"));
    }
    let meta = read_checkpoint_meta(&root, &commit_oid);
    // 旧格式（v1）检查点没有记录检查点创建前已存在的嵌套仓库目录，无法区分目录创建时间，
    // 必须保留当前工作区里所有现存嵌套仓库，且 `git clean` 只用单 `-f`（`-fd`）。
    let (preserved_dirs, clean_nested_repos) = match &meta {
        Some(m) => (m.preserved_dirs.clone(), true),
        None => (nested_git_dirs(&root), false),
    };
    if let Some(conflict) =
        checkpoint_restore_conflict_at_root(&root, &commit_oid, &preserved_dirs)?
    {
        return Err(conflict);
    }
    let index_commit = meta.as_ref().and_then(|m| m.index_commit.clone());

    // 1. 先用检查点提交树覆写工作区与索引（还原被改动的 `.gitignore` 与所有检查点内文件）。
    //    若遇到未跟踪目录与检查点内同名文件冲突（D/F 冲突），先恢复根 `.gitignore`、暂存非忽略项后再重试。
    if user_git_status(&root, &["read-tree", "-u", "--reset", &commit_oid]).is_err() {
        let _ = git_status(&root, &["checkout", &commit_oid, "--", ".gitignore"]);
        let mut excludes = unborn_nested_git_dirs(&root);
        excludes.extend(preserved_dirs.iter().cloned());
        excludes.sort();
        excludes.dedup();
        let add_args = add_all_args_with_excludes(&excludes);
        let add_refs: Vec<&str> = add_args.iter().map(String::as_str).collect();
        let _ = user_git_status(&root, &add_refs);
        user_git_status(&root, &["read-tree", "-u", "--reset", &commit_oid])?;
    }

    // 2. 清理晚于检查点产生的非忽略未跟踪文件（`-fd`/`-ffd` 不加 `-x`，因此保留所有被恢复后 `.gitignore`
    //    忽略的构建缓存与已在检查点索引中的文件，并显式 `-e` 保留检查点创建前已存在的嵌套仓库目录；
    //    连跑两遍以防子目录新建的 `.gitignore` 首遍刚被删）。
    let clean_args = clean_args_with_preserved(&preserved_dirs, clean_nested_repos);
    let clean_refs: Vec<&str> = clean_args.iter().map(String::as_str).collect();
    user_git_status(&root, &clean_refs)?;
    let _ = user_git_status(&root, &clean_refs);
    let _ = fs::create_dir_all(cwd);

    // 3. 将 HEAD 与分支引用拨回检查点记录的基准提交（不改动工作区文件）。
    match head_oid {
        Some(target_head) => {
            let current_branch = branch_name(&root)?;
            if let Some(target_branch) = branch.filter(|b| !b.is_empty()) {
                let branch_ref = format!("refs/heads/{target_branch}");
                if current_branch.as_deref() == Some(target_branch) {
                    if user_git_status(&root, &["reset", "--soft", "-q", target_head]).is_err() {
                        git_status(&root, &["update-ref", &branch_ref, target_head])?;
                    }
                } else if branch_checked_out_elsewhere(&root, &branch_ref) {
                    // 目标分支正被其它工作树检出，绝不篡改其它工作树的分支头，退回分离头指针。
                    git_status(&root, &["update-ref", "--no-deref", "HEAD", target_head])?;
                } else {
                    let _ = git_status(&root, &["update-ref", &branch_ref, target_head]);
                    if git_status(&root, &["symbolic-ref", "HEAD", &branch_ref]).is_err() {
                        git_status(&root, &["update-ref", "--no-deref", "HEAD", target_head])?;
                    }
                }
            } else {
                git_status(&root, &["update-ref", "--no-deref", "HEAD", target_head])?;
            }
        }
        None => {
            // 检查点捕获时尚无任何提交（unborn 仓库）：恢复 unborn HEAD，保留工作区里的未提交文件。
            let target_branch = branch
                .filter(|b| !b.is_empty())
                .unwrap_or("main");
            let branch_ref = format!("refs/heads/{target_branch}");
            if !branch_checked_out_elsewhere(&root, &branch_ref) {
                let _ = git_status(&root, &["symbolic-ref", "HEAD", &branch_ref]);
                let _ = git_status(&root, &["update-ref", "-d", &branch_ref]);
            }
        }
    }

    // 4. 独立恢复暂存区（index）：不带 `-u` 的 `read-tree --reset` 只更新索引而不触碰刚刚铺好的工作区文件。
    if let Some(idx_commit) = index_commit.as_deref() {
        user_git_status(&root, &["read-tree", "--reset", idx_commit])?;
    } else if let Some(target_head) = head_oid {
        user_git_status(&root, &["read-tree", "--reset", target_head])?;
    } else {
        user_git_status(&root, &["read-tree", "--empty"])?;
    }
    let _ = user_git_status(&root, &["update-index", "-q", "--refresh"]);

    Ok(())
}

/// 批量清理不再需要的检查点隐藏引用。
pub fn delete_checkpoint_refs(cwd: &Path, refs: &[String]) {
    if refs.is_empty() || !cwd.is_dir() {
        return;
    }
    let Ok(root) = repository_root(cwd) else {
        return;
    };
    for reference in refs {
        if reference.starts_with(CHECKPOINT_REF_PREFIX) {
            let _ = git_status(&root, &["update-ref", "-d", reference]);
        }
    }
}

/// 读取最近若干条提交标题，供 AI 生成提交说明时参考仓库提交风格。
pub fn recent_commit_subjects(cwd: &Path, limit: usize) -> Vec<String> {
    if !cwd.is_dir() {
        return Vec::new();
    }
    let Ok(root) = repository_root(cwd) else {
        return Vec::new();
    };
    if !repo_has_commit(&root).unwrap_or(false) {
        return Vec::new();
    }
    let limit_arg = format!("-n{}", limit.clamp(1, 20));
    let Ok(output) = git_output(&root, &["log", &limit_arg, "--pretty=format:%s"]) else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    aiwb_proc::decode_child_bytes(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aiwb-cp-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let mut cmd = Command::new("git");
        cmd.args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        aiwb_proc::hide_console_std(&mut cmd);
        let status = cmd.status().unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    #[test]
    fn restores_head_tracked_untracked_and_preserves_gitignored_artifacts() {
        let repo = scratch("full-restore");
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "core.autocrlf", "false"]);
        fs::write(repo.join(".gitignore"), "target/\n").unwrap();
        fs::write(repo.join("tracked.txt"), "v1\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "init",
            ],
        );

        // 轮次开始前已有脏改动、未跟踪草稿文件，以及被忽略的构建产物。
        fs::write(repo.join("tracked.txt"), "v1-dirty\n").unwrap();
        fs::write(repo.join("pre_untracked.txt"), "keep-me\n").unwrap();
        fs::create_dir_all(repo.join("target")).unwrap();
        fs::write(repo.join("target/cache.bin"), "compiled-bytes").unwrap();

        let cp = capture_checkpoint(&repo, "sess-1", "turn-1", "pre")
            .unwrap()
            .unwrap();
        assert!(!has_working_tree_changed_since(&repo, &cp.reference).unwrap());

        // 模拟 Agent 在该轮中修改文件、新建未跟踪文件，还执行了 git commit 推进了 HEAD。
        fs::write(repo.join("tracked.txt"), "v2-by-agent\n").unwrap();
        fs::create_dir_all(repo.join("src")).unwrap();
        fs::write(repo.join("src/agent_added.rs"), "pub fn bad() {}\n").unwrap();
        run_git(&repo, &["add", "tracked.txt", "src/agent_added.rs"]);
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Agent",
                "-c",
                "user.email=a@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "agent bad commit",
            ],
        );
        fs::write(repo.join("extra_untracked.log"), "noise\n").unwrap();

        assert!(has_working_tree_changed_since(&repo, &cp.reference).unwrap());

        // 执行完整回退！
        restore_checkpoint(&repo, &cp.reference, cp.head_oid.as_deref(), cp.branch.as_deref())
            .unwrap();

        assert_eq!(head_sha(&repo).ok(), cp.head_oid);
        assert_eq!(branch_name(&repo).unwrap().as_deref(), Some("main"));
        assert_eq!(
            fs::read_to_string(repo.join("tracked.txt")).unwrap(),
            "v1-dirty\n"
        );
        assert_eq!(
            fs::read_to_string(repo.join("pre_untracked.txt")).unwrap(),
            "keep-me\n"
        );
        assert!(!repo.join("src/agent_added.rs").exists());
        assert!(!repo.join("extra_untracked.log").exists());
        // .gitignore 构建缓存完好无损！
        assert_eq!(
            fs::read_to_string(repo.join("target/cache.bin")).unwrap(),
            "compiled-bytes"
        );
        assert!(!has_working_tree_changed_since(&repo, &cp.reference).unwrap());

        delete_checkpoint_refs(&repo, &[cp.reference.clone()]);
        assert!(!has_checkpoint_ref(&repo, &cp.reference));
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn restores_unborn_repository_cleanly() {
        let repo = scratch("unborn");
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "core.autocrlf", "false"]);
        fs::write(repo.join("draft.md"), "hello\n").unwrap();

        let cp = capture_checkpoint(&repo, "sess-u", "turn-1", "pre")
            .unwrap()
            .unwrap();
        assert_eq!(cp.head_oid, None);

        fs::write(repo.join("agent.txt"), "oops\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Agent",
                "-c",
                "user.email=a@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "first commit",
            ],
        );
        assert!(repo_has_commit(&repo).unwrap());

        restore_checkpoint(&repo, &cp.reference, cp.head_oid.as_deref(), cp.branch.as_deref())
            .unwrap();
        assert!(!repo_has_commit(&repo).unwrap());
        assert_eq!(fs::read_to_string(repo.join("draft.md")).unwrap(), "hello\n");
        assert!(!repo.join("agent.txt").exists());

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn restores_modified_gitignore_and_cleans_unborn_nested_git_repo() {
        let repo = scratch("nested-git-and-gitignore");
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "core.autocrlf", "false"]);
        fs::write(repo.join(".gitignore"), "target/\n").unwrap();
        fs::write(repo.join("app.rs"), "fn main() {}\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "init",
            ],
        );

        fs::create_dir_all(repo.join("target")).unwrap();
        fs::write(repo.join("target/keep.o"), "cached").unwrap();
        fs::write(repo.join("draft.txt"), "draft").unwrap();

        let cp = capture_checkpoint(&repo, "sess-g", "turn-1", "pre")
            .unwrap()
            .unwrap();

        // Agent 篡改了 `.gitignore` 忽略 `*.gen.rs`，同时创建了 `foo.gen.rs`，并执行了 `git init sub_crate`（unborn 嵌套仓库）。
        fs::write(repo.join(".gitignore"), "target/\n*.gen.rs\n").unwrap();
        fs::write(repo.join("foo.gen.rs"), "generated\n").unwrap();
        let sub = repo.join("sub_crate");
        fs::create_dir_all(&sub).unwrap();
        run_git(&sub, &["init", "-b", "main"]);
        fs::write(sub.join("Cargo.toml"), "[package]\nname = \"sub\"\n").unwrap();

        assert!(has_working_tree_changed_since(&repo, &cp.reference).unwrap());
        // 即使存在 unborn 嵌套 `.git`，再次捕获检查点也不能以 exit 128 崩溃。
        let post_cp = capture_checkpoint(&repo, "sess-g", "turn-1", "post")
            .unwrap()
            .unwrap();
        assert_ne!(post_cp.reference, cp.reference);

        restore_checkpoint(&repo, &cp.reference, cp.head_oid.as_deref(), cp.branch.as_deref())
            .unwrap();

        assert_eq!(
            fs::read_to_string(repo.join(".gitignore")).unwrap(),
            "target/\n"
        );
        assert_eq!(fs::read_to_string(repo.join("draft.txt")).unwrap(), "draft");
        assert_eq!(
            fs::read_to_string(repo.join("target/keep.o")).unwrap(),
            "cached"
        );
        assert!(!repo.join("foo.gen.rs").exists());
        assert!(!sub.exists());
        assert!(!has_working_tree_changed_since(&repo, &cp.reference).unwrap());

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn restore_detaches_head_instead_of_clobbering_branch_checked_out_in_other_worktree() {
        let repo = scratch("wt-branch-guard");
        let wt = scratch("wt-branch-guard-linked");
        let _ = fs::remove_dir_all(&wt);
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "core.autocrlf", "false"]);
        fs::write(repo.join("a.txt"), "c1\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "c1",
            ],
        );

        run_git(
            &repo,
            &["worktree", "add", "-b", "feat", &wt.to_string_lossy(), "main"],
        );
        // 在工作树 `wt` 的 `feat` 分支捕获检查点 c1。
        let cp = capture_checkpoint(&wt, "sess-wt", "turn-1", "pre")
            .unwrap()
            .unwrap();
        assert_eq!(cp.branch.as_deref(), Some("feat"));

        // 随后 `wt` 切到新分支 `other`，而主仓库 `repo` 检出了 `feat` 并推进到新提交 c2。
        run_git(&wt, &["checkout", "-b", "other"]);
        run_git(&repo, &["checkout", "feat"]);
        fs::write(repo.join("a.txt"), "c2-in-main-repo\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(
            &repo,
            &[
                "-c",
                "user.name=User",
                "-c",
                "user.email=u@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "c2",
            ],
        );
        let main_feat_sha = head_sha(&repo).unwrap();

        // 在 `wt` 上还原 cp：不能篡改主仓库正检出的 `refs/heads/feat`，`wt` 应安全落在分离头指针 c1。
        restore_checkpoint(&wt, &cp.reference, cp.head_oid.as_deref(), cp.branch.as_deref())
            .unwrap();
        assert_eq!(head_sha(&repo).unwrap(), main_feat_sha);
        assert_eq!(head_sha(&wt).ok(), cp.head_oid);
        assert_eq!(branch_name(&wt).unwrap(), None);
        assert_eq!(fs::read_to_string(wt.join("a.txt")).unwrap(), "c1\n");

        let _ = fs::remove_dir_all(&wt);
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn preserves_preexisting_unborn_nested_git_repos_while_cleaning_new_ones() {
        let repo = scratch("preexisting-nested-git");
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "core.autocrlf", "false"]);
        fs::write(repo.join("root.txt"), "v1\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "init",
            ],
        );

        // 检查点之前已经存在的 unborn 嵌套仓库（含顶层、嵌套在未跟踪父目录下、以及带通配符字符的目录名）。
        let pre_sub = repo.join("pre_sub");
        let deep_sub = repo.join("packages/deep_sub");
        let glob_sub = repo.join("dir [1]");
        for dir in [&pre_sub, &deep_sub, &glob_sub] {
            fs::create_dir_all(dir).unwrap();
            run_git(dir, &["init", "-b", "main"]);
            fs::write(dir.join("keep.txt"), "precious\n").unwrap();
        }

        let cp = capture_checkpoint(&repo, "sess-nested", "turn-1", "pre")
            .unwrap()
            .unwrap();
        assert!(!has_working_tree_changed_since(&repo, &cp.reference).unwrap());

        // 回合中修改主仓库文件、在未跟踪父目录加杂项文件、并新建一个 unborn 嵌套仓库。
        fs::write(repo.join("root.txt"), "v2\n").unwrap();
        fs::write(repo.join("packages/noise.txt"), "noise\n").unwrap();
        let new_sub = repo.join("agent_sub");
        fs::create_dir_all(&new_sub).unwrap();
        run_git(&new_sub, &["init", "-b", "main"]);
        fs::write(new_sub.join("temp.txt"), "temp\n").unwrap();

        assert!(has_working_tree_changed_since(&repo, &cp.reference).unwrap());

        restore_checkpoint(&repo, &cp.reference, cp.head_oid.as_deref(), cp.branch.as_deref())
            .unwrap();

        assert_eq!(fs::read_to_string(repo.join("root.txt")).unwrap(), "v1\n");
        assert_eq!(fs::read_to_string(pre_sub.join("keep.txt")).unwrap(), "precious\n");
        assert_eq!(fs::read_to_string(deep_sub.join("keep.txt")).unwrap(), "precious\n");
        assert_eq!(fs::read_to_string(glob_sub.join("keep.txt")).unwrap(), "precious\n");
        assert!(pre_sub.join(".git").exists());
        assert!(deep_sub.join(".git").exists());
        assert!(glob_sub.join(".git").exists());
        assert!(!repo.join("packages/noise.txt").exists());
        assert!(!new_sub.exists());
        assert!(!has_working_tree_changed_since(&repo, &cp.reference).unwrap());

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn preserves_staged_index_separately_from_head_and_working_tree() {
        let repo = scratch("staged-vs-worktree");
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "core.autocrlf", "false"]);
        fs::write(repo.join("file.txt"), "committed-v1\n").unwrap();
        fs::write(repo.join("to_delete.txt"), "gone-soon\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "init",
            ],
        );

        // 构造三版本不同的状态：
        // - file.txt: HEAD="committed-v1", index="staged-v2", worktree="worktree-v3"
        // - staged_new.txt: 不在 HEAD, index="new-staged", worktree="new-worktree"
        // - to_delete.txt: 在 HEAD, index 已删除, worktree 已删除
        fs::write(repo.join("file.txt"), "staged-v2\n").unwrap();
        fs::write(repo.join("staged_new.txt"), "new-staged\n").unwrap();
        run_git(&repo, &["add", "file.txt", "staged_new.txt"]);
        run_git(&repo, &["rm", "-q", "to_delete.txt"]);
        fs::write(repo.join("file.txt"), "worktree-v3\n").unwrap();
        fs::write(repo.join("staged_new.txt"), "new-worktree\n").unwrap();

        let cp = capture_checkpoint(&repo, "sess-idx", "turn-1", "pre")
            .unwrap()
            .unwrap();
        assert!(!has_working_tree_changed_since(&repo, &cp.reference).unwrap());

        // 模拟 Agent 覆盖文件、改动暂存区并提交。
        fs::write(repo.join("file.txt"), "agent-v4\n").unwrap();
        fs::write(repo.join("to_delete.txt"), "recreated-by-agent\n").unwrap();
        run_git(&repo, &["add", "-A"]);
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Agent",
                "-c",
                "user.email=a@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "agent commit",
            ],
        );

        restore_checkpoint(&repo, &cp.reference, cp.head_oid.as_deref(), cp.branch.as_deref())
            .unwrap();

        assert_eq!(head_sha(&repo).ok(), cp.head_oid);
        assert_eq!(git_stdout(&repo, &["show", "HEAD:file.txt"]).unwrap(), "committed-v1");
        assert_eq!(git_stdout(&repo, &["show", ":file.txt"]).unwrap(), "staged-v2");
        assert_eq!(fs::read_to_string(repo.join("file.txt")).unwrap(), "worktree-v3\n");
        assert_eq!(git_stdout(&repo, &["show", ":staged_new.txt"]).unwrap(), "new-staged");
        assert_eq!(
            fs::read_to_string(repo.join("staged_new.txt")).unwrap(),
            "new-worktree\n"
        );
        assert!(git_stdout(&repo, &["show", ":to_delete.txt"]).is_err());
        assert!(!repo.join("to_delete.txt").exists());
        assert!(!has_working_tree_changed_since(&repo, &cp.reference).unwrap());

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn detects_empty_commit_user_commit_branch_switch_and_staging_changes() {
        let repo = scratch("detect-head-branch");
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "core.autocrlf", "false"]);
        fs::write(repo.join("a.txt"), "v1\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "init",
            ],
        );

        // 回合结束时 a.txt 有未提交修改 v2
        fs::write(repo.join("a.txt"), "v2\n").unwrap();
        let post_cp = capture_checkpoint(&repo, "sess-chg", "turn-1", "post")
            .unwrap()
            .unwrap();
        assert!(!has_working_tree_changed_since(&repo, &post_cp.reference).unwrap());

        // 1. 仅改变暂存区（工作区文件内容相同）应被检测到
        run_git(&repo, &["add", "a.txt"]);
        assert!(has_working_tree_changed_since(&repo, &post_cp.reference).unwrap());

        // 2. 用户将本轮改动提交（工作区文件内容依然是 v2，但 HEAD 已推进）应被检测到
        run_git(
            &repo,
            &[
                "-c",
                "user.name=User",
                "-c",
                "user.email=u@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "user commits turn changes",
            ],
        );
        assert!(has_working_tree_changed_since(&repo, &post_cp.reference).unwrap());

        // 在干净工作区重新拍检查点，测试空提交和切分支
        let clean_cp = capture_checkpoint(&repo, "sess-chg", "turn-2", "post")
            .unwrap()
            .unwrap();
        assert!(!has_working_tree_changed_since(&repo, &clean_cp.reference).unwrap());

        // 3. 创建空提交（文件内容完全不变，但 HEAD 变化）
        run_git(
            &repo,
            &[
                "-c",
                "user.name=User",
                "-c",
                "user.email=u@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "empty marker",
            ],
        );
        assert!(has_working_tree_changed_since(&repo, &clean_cp.reference).unwrap());

        // 4. 回到同一提交但切换分支名
        let clean_head = clean_cp.head_oid.as_deref().unwrap();
        run_git(&repo, &["checkout", "-b", "other-branch", clean_head]);
        assert!(has_working_tree_changed_since(&repo, &clean_cp.reference).unwrap());

        // 5. 分离头指针在同一提交
        run_git(&repo, &["checkout", "--detach", clean_head]);
        assert!(has_working_tree_changed_since(&repo, &clean_cp.reference).unwrap());

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn legacy_v1_checkpoint_restore_preserves_existing_nested_git_repos() {
        let repo = scratch("legacy-v1-nested");
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "core.autocrlf", "false"]);
        fs::write(repo.join("app.txt"), "v1\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "init",
            ],
        );
        let head = head_sha(&repo).unwrap();

        // 检查点创建前已存在 unborn 嵌套仓库（无 AIWB-Meta 的旧格式检查点会跳过它，不记录 preserved_dirs）。
        let nested = repo.join("pre_nested");
        fs::create_dir_all(&nested).unwrap();
        run_git(&nested, &["init", "-b", "main"]);
        fs::write(nested.join("keep.txt"), "from-before\n").unwrap();

        // 构造不带 AIWB-Meta 的旧格式（v1）检查点提交并挂到隐藏引用。
        let legacy_commit =
            commit_worktree_tree(&repo, Some(&head), "AI Workbench checkpoint").unwrap();
        let legacy_ref = format!("{CHECKPOINT_REF_PREFIX}sess-v1/turn-1-pre");
        git_status(&repo, &["update-ref", &legacy_ref, &legacy_commit]).unwrap();

        // 回合中修改跟踪文件并创建普通未跟踪文件。
        fs::write(repo.join("app.txt"), "v2\n").unwrap();
        fs::write(repo.join("noise.txt"), "remove-me\n").unwrap();

        restore_checkpoint(&repo, &legacy_ref, Some(&head), Some("main")).unwrap();

        assert_eq!(fs::read_to_string(repo.join("app.txt")).unwrap(), "v1\n");
        assert!(!repo.join("noise.txt").exists());
        assert_eq!(
            fs::read_to_string(nested.join("keep.txt")).unwrap(),
            "from-before\n"
        );
        assert!(nested.join(".git").exists());

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn rejects_checkpoint_capture_and_restore_during_unresolved_merge_or_active_merge_head() {
        let repo = scratch("merge-conflict-guard");
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "core.autocrlf", "false"]);
        fs::write(repo.join("shared.txt"), "base\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "base",
            ],
        );

        // 分支 feat 修改同一行制造冲突；另一分支 clean-feat 修改独立文件用于测试 --no-commit MERGE_HEAD。
        run_git(&repo, &["checkout", "-b", "feat"]);
        fs::write(repo.join("shared.txt"), "feat-version\n").unwrap();
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-am",
                "feat change",
            ],
        );

        run_git(&repo, &["checkout", "main"]);
        run_git(&repo, &["checkout", "-b", "clean-feat"]);
        fs::write(repo.join("extra.txt"), "clean-feat\n").unwrap();
        run_git(&repo, &["add", "extra.txt"]);
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "clean feat",
            ],
        );

        run_git(&repo, &["checkout", "main"]);
        fs::write(repo.join("shared.txt"), "main-version\n").unwrap();
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-am",
                "main change",
            ],
        );

        // 合并开始前先拍一个正常检查点。
        let pre_merge_cp = capture_checkpoint(&repo, "sess-m", "turn-1", "pre")
            .unwrap()
            .unwrap();

        // 场景 A：触发真实合并冲突（3 条未合并冲突条目 + MERGE_HEAD）。
        let merge_status = Command::new("git")
            .args(["merge", "feat"])
            .current_dir(&repo)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(!merge_status.success(), "merge should conflict");
        let unmerged_before = git_stdout(&repo, &["ls-files", "-u"]).unwrap();
        assert_eq!(unmerged_before.lines().count(), 3);

        // 1) 冲突期间 capture_checkpoint 必须拒绝，不伪造残缺检查点且不破坏冲突条目。
        assert!(capture_checkpoint(&repo, "sess-m", "turn-2", "pre").is_err());
        assert_eq!(
            git_stdout(&repo, &["ls-files", "-u"]).unwrap().lines().count(),
            3
        );
        assert!(has_working_tree_changed_since(&repo, &pre_merge_cp.reference).unwrap());

        // 2) 冲突期间 restore_checkpoint 回退到合并前也必须提前拒绝，保持冲突和 MERGE_HEAD 原样。
        assert!(restore_checkpoint(
            &repo,
            &pre_merge_cp.reference,
            pre_merge_cp.head_oid.as_deref(),
            pre_merge_cp.branch.as_deref()
        )
        .is_err());
        assert_eq!(
            git_stdout(&repo, &["ls-files", "-u"]).unwrap().lines().count(),
            3
        );
        assert!(owned_git_file(&repo, "MERGE_HEAD").unwrap().exists());

        // 中止冲突合并。
        run_git(&repo, &["merge", "--abort"]);

        // 场景 B：无冲突但存在 MERGE_HEAD（`git merge --no-commit`）。
        run_git(&repo, &["merge", "--no-commit", "--no-ff", "clean-feat"]);
        assert!(owned_git_file(&repo, "MERGE_HEAD").unwrap().exists());
        assert!(capture_checkpoint(&repo, "sess-m", "turn-3", "pre").is_err());
        assert!(has_working_tree_changed_since(&repo, &pre_merge_cp.reference).unwrap());
        assert!(restore_checkpoint(
            &repo,
            &pre_merge_cp.reference,
            pre_merge_cp.head_oid.as_deref(),
            pre_merge_cp.branch.as_deref()
        )
        .is_err());
        // 工作区和 MERGE_HEAD 未被破坏
        assert!(repo.join("extra.txt").exists());
        assert!(owned_git_file(&repo, "MERGE_HEAD").unwrap().exists());

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn legacy_checkpoint_rejects_path_conflict_with_existing_nested_git_repo() {
        let repo = scratch("legacy-df-conflict");
        run_git(&repo, &["init", "-b", "main"]);
        run_git(&repo, &["config", "core.autocrlf", "false"]);
        fs::write(repo.join("file"), "old-regular-file\n").unwrap();
        fs::create_dir_all(repo.join("dir")).unwrap();
        fs::write(repo.join("dir/inside.txt"), "inside\n").unwrap();
        run_git(&repo, &["add", "."]);
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "init",
            ],
        );
        let head = head_sha(&repo).unwrap();
        let legacy_commit =
            commit_worktree_tree(&repo, Some(&head), "AI Workbench checkpoint").unwrap();
        let legacy_ref = format!("{CHECKPOINT_REF_PREFIX}sess-df/turn-1-pre");
        git_status(&repo, &["update-ref", &legacy_ref, &legacy_commit]).unwrap();

        // 场景 A：直接删除普通文件 `file`（未 git rm）并在原路径初始化包含唯一文件的嵌套仓库。
        fs::remove_file(repo.join("file")).unwrap();
        fs::create_dir_all(repo.join("file")).unwrap();
        run_git(&repo.join("file"), &["init", "-b", "main"]);
        fs::write(repo.join("file/only.txt"), "irreplaceable-a\n").unwrap();

        assert!(checkpoint_restore_conflict(&repo, &legacy_ref)
            .unwrap()
            .is_some());
        assert!(restore_checkpoint(&repo, &legacy_ref, Some(&head), Some("main")).is_err());
        assert!(repo.join("file/.git").exists());
        assert_eq!(
            fs::read_to_string(repo.join("file/only.txt")).unwrap(),
            "irreplaceable-a\n"
        );

        // 场景 B：在内层仓库提交并在外层 `git add file` 成为 `160000` 条目，同时带未提交草稿。
        run_git(
            &repo.join("file"),
            &[
                "-c",
                "user.name=Sub",
                "-c",
                "user.email=s@test",
                "add",
                ".",
            ],
        );
        run_git(
            &repo.join("file"),
            &[
                "-c",
                "user.name=Sub",
                "-c",
                "user.email=s@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "sub commit",
            ],
        );
        fs::write(repo.join("file/draft.txt"), "draft-b\n").unwrap();
        run_git(&repo, &["add", "file"]);

        assert!(checkpoint_restore_conflict(&repo, &legacy_ref)
            .unwrap()
            .is_some());
        assert!(restore_checkpoint(&repo, &legacy_ref, Some(&head), Some("main")).is_err());
        assert!(repo.join("file/.git").exists());
        assert_eq!(
            fs::read_to_string(repo.join("file/only.txt")).unwrap(),
            "irreplaceable-a\n"
        );
        assert_eq!(
            fs::read_to_string(repo.join("file/draft.txt")).unwrap(),
            "draft-b\n"
        );

        // 场景 C：外层 `git rm -rf file` 提交后，重新创建未跟踪嵌套仓库 `file`。
        let _ = fs::remove_dir_all(repo.join("file"));
        run_git(&repo, &["rm", "-rf", "--ignore-unmatch", "file"]);
        run_git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "remove file",
            ],
        );
        fs::create_dir_all(repo.join("file")).unwrap();
        run_git(&repo.join("file"), &["init", "-b", "main"]);
        fs::write(repo.join("file/only.txt"), "irreplaceable-c\n").unwrap();

        assert!(checkpoint_restore_conflict(&repo, &legacy_ref)
            .unwrap()
            .is_some());
        assert!(restore_checkpoint(&repo, &legacy_ref, Some(&head), Some("main")).is_err());
        assert!(repo.join("file/.git").exists());
        assert_eq!(
            fs::read_to_string(repo.join("file/only.txt")).unwrap(),
            "irreplaceable-c\n"
        );

        let _ = fs::remove_dir_all(&repo);
    }
}
