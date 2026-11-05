//! 本地分支列表、检出和创建。只动 `refs/heads`，不碰远端。

use std::path::Path;

use serde::Serialize;

use super::{current_branch, git_output, inside_work_tree};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitBranchMenu {
    pub current: Option<String>,
    pub branches: Vec<String>,
    /// 未提交文件数，含未跟踪。数不清时省略，不填 0 充数。
    pub dirty_files: Option<u32>,
}

pub fn local_branch_menu(root: &Path) -> Result<GitBranchMenu, String> {
    if !inside_work_tree(root)? {
        return Err("当前目录不是 git 仓库".into());
    }
    let current = current_branch(root)?;
    let mut branches = list_local_branches(root)?;
    if let Some(name) = current.clone() {
        if !branches.iter().any(|branch| branch == &name) {
            branches.push(name);
        }
    }
    sort_branches(&mut branches, current.as_deref());
    let dirty_files = match dirty_file_count(root) {
        Ok(count) => count,
        Err(_) => None,
    };
    Ok(GitBranchMenu {
        current,
        branches,
        dirty_files,
    })
}

pub fn checkout_local_branch(root: &Path, name: &str) -> Result<(), String> {
    let name = require_branch_name(name)?;
    if !inside_work_tree(root)? {
        return Err("当前目录不是 git 仓库".into());
    }
    if current_branch(root)?.as_deref() == Some(name.as_str()) {
        return Ok(());
    }
    let branches = list_local_branches(root)?;
    if !branches.iter().any(|branch| branch == &name) {
        return Err("找不到这个分支".into());
    }
    run_switch(root, &["switch", &name], "无法切换分支")
}

pub fn create_and_checkout_branch(root: &Path, name: &str) -> Result<(), String> {
    let name = require_branch_name(name)?;
    if !inside_work_tree(root)? {
        return Err("当前目录不是 git 仓库".into());
    }
    let branches = list_local_branches(root)?;
    if branches.iter().any(|branch| branch == &name)
        || current_branch(root)?.as_deref() == Some(name.as_str())
    {
        return Err("分支已存在".into());
    }
    run_switch(root, &["switch", "-c", &name], "无法创建分支")
}

fn list_local_branches(root: &Path) -> Result<Vec<String>, String> {
    let output = git_output(
        root,
        &[
            "-c",
            "safe.bareRepository=explicit",
            "-c",
            "core.quotepath=false",
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads",
        ],
    )?;
    if !output.status.success() {
        let stderr = stderr_text(&output.stderr);
        if stderr.contains("not a git repository") {
            return Err("当前目录不是 git 仓库".into());
        }
        return Err("无法读取分支".into());
    }
    let text = aiwb_proc::decode_child_bytes(&output.stdout);
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

fn dirty_file_count(root: &Path) -> Result<Option<u32>, String> {
    let output = git_output(
        root,
        &[
            "-c",
            "safe.bareRepository=explicit",
            "-c",
            "core.quotepath=false",
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "-z",
        ],
    )?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(status_paths(&output.stdout).len() as u32))
}

fn run_switch(root: &Path, args: &[&str], fallback: &str) -> Result<(), String> {
    let mut full = vec!["-c", "safe.bareRepository=explicit"];
    full.extend_from_slice(args);
    let output = git_output(root, &full)?;
    if output.status.success() {
        return Ok(());
    }
    Err(translate_git_failure(
        &stderr_text(&output.stderr),
        fallback,
    ))
}

fn stderr_text(bytes: &[u8]) -> String {
    aiwb_proc::decode_child_bytes(bytes)
        .trim()
        .to_string()
}

fn require_branch_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("请输入分支名".into());
    }
    if !valid_branch_name(name) {
        return Err("分支名无效".into());
    }
    Ok(name.to_string())
}

/// 本地分支名。对齐 `git check-ref-format` 里适用于短分支名的限制。
fn valid_branch_name(name: &str) -> bool {
    if name.is_empty() || name.eq_ignore_ascii_case("head") || name == "@" {
        return false;
    }
    if name.starts_with('-')
        || name.starts_with('.')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.contains("//")
        || name.contains("..")
        || name.contains("@{")
        || name.contains('\\')
    {
        return false;
    }
    if name
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, ' ' | '~' | '^' | ':' | '?' | '*' | '['))
    {
        return false;
    }
    name.split('/').all(|part| {
        !part.is_empty()
            && !part.starts_with('.')
            && !part.ends_with('.')
            && !part.ends_with(".lock")
            && part.len() <= 255
    })
}

fn sort_branches(branches: &mut Vec<String>, current: Option<&str>) {
    branches.sort_by(|a, b| {
        a.to_lowercase()
            .cmp(&b.to_lowercase())
            .then_with(|| a.cmp(b))
    });
    let Some(current) = current else {
        return;
    };
    if let Some(pos) = branches.iter().position(|name| name == current) {
        let name = branches.remove(pos);
        branches.insert(0, name);
    }
}

fn translate_git_failure(stderr: &str, fallback: &str) -> String {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("not a git repository") {
        return "当前目录不是 git 仓库".into();
    }
    if lower.contains("not a valid branch name") {
        return "分支名无效".into();
    }
    if lower.contains("already exists") {
        return "分支已存在".into();
    }
    if lower.contains("would be overwritten")
        || lower.contains("please commit your changes or stash")
    {
        return "有未提交的改动，无法切换分支".into();
    }
    if lower.contains("need to resolve your current index") || lower.contains("unmerged") {
        return "有未合并的改动，无法切换分支".into();
    }
    if lower.contains("invalid reference")
        || lower.contains("did not match any")
        || lower.contains("pathspec")
    {
        return "找不到这个分支".into();
    }
    fallback.to_string()
}

/// `git status --porcelain=v1 -z` 里的文件，一条记录一个。改名、复制后面跟着的原路径不单算。
pub(crate) fn status_paths(bytes: &[u8]) -> Vec<String> {
    let text = aiwb_proc::decode_child_bytes(bytes);
    let mut paths = Vec::new();
    let mut entries = text.split('\0');
    while let Some(entry) = entries.next() {
        let (Some(status), Some(path)) = (entry.get(..2), entry.get(3..)) else {
            break;
        };
        paths.push(path.to_string());
        if status.contains(['R', 'C']) {
            entries.next();
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ai-workbench-branch-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git_ready() -> bool {
        let mut probe = Command::new("git");
        probe
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        super::super::hide_console(&mut probe);
        probe
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn run_git(cwd: &Path, args: &[&str]) -> bool {
        let mut command = Command::new("git");
        command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        super::super::hide_console(&mut command);
        command
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn init_repo(name: &str) -> PathBuf {
        let root = scratch(name);
        assert!(run_git(&root, &["init", "-b", "master"]));
        assert!(run_git(
            &root,
            &["config", "user.email", "branch@example.com"]
        ));
        assert!(run_git(&root, &["config", "user.name", "branch"]));
        assert!(run_git(&root, &["config", "commit.gpgsign", "false"]));
        assert!(run_git(&root, &["config", "core.autocrlf", "false"]));
        root
    }

    fn commit_file(root: &Path, name: &str, body: &str, message: &str) {
        fs::write(root.join(name), body).unwrap();
        assert!(run_git(root, &["add", name]));
        assert!(run_git(
            root,
            &["-c", "commit.gpgsign=false", "commit", "-m", message]
        ));
    }

    #[test]
    fn branch_name_rules_match_short_ref_format() {
        for name in ["master", "feature/foo", "功能", "a.b", "foo.locksmith"] {
            assert!(valid_branch_name(name), "{name}");
        }
        for name in [
            "",
            "foo..bar",
            "foo bar",
            "-wip",
            "foo.lock",
            "feature.lock/x",
            "foo/",
            "/foo",
            "foo//bar",
            ".foo",
            "foo.",
            "HEAD",
            "head",
            "@",
            "foo@{1}",
            "foo~1",
            "a\\b",
            "foo:bar",
            "foo?",
            "foo*",
            "foo[bar]",
        ] {
            assert!(!valid_branch_name(name), "{name}");
        }
        assert_eq!(require_branch_name("  ").unwrap_err(), "请输入分支名");
        assert_eq!(require_branch_name(" master ").unwrap(), "master");
        assert_eq!(require_branch_name("foo..bar").unwrap_err(), "分支名无效");
    }

    #[test]
    fn status_paths_count_renames_once() {
        assert!(status_paths(b"").is_empty());
        assert_eq!(status_paths(b" M a.txt\0?? b.txt\0"), ["a.txt", "b.txt"]);
        assert_eq!(status_paths(b"RM renamed.txt\0note.txt\0"), ["renamed.txt"]);
        assert_eq!(
            status_paths(b"RM renamed.txt\0note.txt\0?? extra.txt\0"),
            ["renamed.txt", "extra.txt"]
        );
    }

    #[test]
    fn git_failure_text_is_chinese() {
        assert_eq!(
            translate_git_failure(
                "error: Your local changes to the following files would be overwritten by checkout:",
                "无法切换分支"
            ),
            "有未提交的改动，无法切换分支"
        );
        assert_eq!(
            translate_git_failure(
                "fatal: a branch named 'master' already exists",
                "无法创建分支"
            ),
            "分支已存在"
        );
        assert_eq!(
            translate_git_failure(
                "fatal: 'foo..bar' is not a valid branch name",
                "无法创建分支"
            ),
            "分支名无效"
        );
        assert_eq!(
            translate_git_failure("fatal: invalid reference: missing", "无法切换分支"),
            "找不到这个分支"
        );
        assert_eq!(
            translate_git_failure("fatal: something else", "无法创建分支"),
            "无法创建分支"
        );
    }

    #[test]
    fn branches_sort_current_first() {
        let mut names = vec!["zeta".into(), "alpha".into(), "Master".into()];
        sort_branches(&mut names, Some("Master"));
        assert_eq!(names, vec!["Master", "alpha", "zeta"]);
    }

    #[test]
    fn menu_lists_checks_out_and_counts_dirty_files() {
        if !git_ready() {
            return;
        }
        let root = init_repo("menu");
        commit_file(&root, "note.txt", "one\n", "base");
        assert!(run_git(&root, &["switch", "-c", "topic"]));
        assert!(run_git(&root, &["switch", "master"]));

        let menu = local_branch_menu(&root).unwrap();
        assert_eq!(menu.current.as_deref(), Some("master"));
        assert_eq!(
            menu.branches,
            vec!["master".to_string(), "topic".to_string()]
        );
        assert_eq!(menu.dirty_files, Some(0));

        fs::write(root.join("note.txt"), "two\n").unwrap();
        fs::write(root.join("extra.txt"), "new\n").unwrap();
        assert_eq!(dirty_file_count(&root).unwrap(), Some(2));

        checkout_local_branch(&root, "topic").unwrap();
        assert_eq!(current_branch(&root).unwrap().as_deref(), Some("topic"));
        checkout_local_branch(&root, "topic").unwrap();

        create_and_checkout_branch(&root, " feature/next ").unwrap();
        assert_eq!(
            current_branch(&root).unwrap().as_deref(),
            Some("feature/next")
        );
        let listed = local_branch_menu(&root).unwrap();
        assert_eq!(listed.current.as_deref(), Some("feature/next"));
        assert!(listed.branches.iter().any(|name| name == "feature/next"));

        assert_eq!(
            create_and_checkout_branch(&root, "topic").unwrap_err(),
            "分支已存在"
        );
        assert_eq!(
            checkout_local_branch(&root, "missing").unwrap_err(),
            "找不到这个分支"
        );
        assert_eq!(
            create_and_checkout_branch(&root, "foo..bar").unwrap_err(),
            "分支名无效"
        );

        let plain = scratch("plain");
        assert_eq!(
            local_branch_menu(&plain).unwrap_err(),
            "当前目录不是 git 仓库"
        );
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(plain);
    }

    #[test]
    fn checkout_reports_dirty_conflict_in_chinese() {
        if !git_ready() {
            return;
        }
        let root = init_repo("conflict");
        commit_file(&root, "f.txt", "a\n", "base");
        assert!(run_git(&root, &["switch", "-c", "other"]));
        commit_file(&root, "f.txt", "b\n", "other");
        assert!(run_git(&root, &["switch", "master"]));
        fs::write(root.join("f.txt"), "c\n").unwrap();
        assert_eq!(
            checkout_local_branch(&root, "other").unwrap_err(),
            "有未提交的改动，无法切换分支"
        );
        assert_eq!(current_branch(&root).unwrap().as_deref(), Some("master"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unborn_branch_is_still_listed() {
        if !git_ready() {
            return;
        }
        let root = init_repo("unborn");
        let menu = local_branch_menu(&root).unwrap();
        assert_eq!(menu.current.as_deref(), Some("master"));
        assert_eq!(menu.branches, vec!["master".to_string()]);
        create_and_checkout_branch(&root, "wip").unwrap();
        assert_eq!(current_branch(&root).unwrap().as_deref(), Some("wip"));
        let _ = fs::remove_dir_all(root);
    }
}
