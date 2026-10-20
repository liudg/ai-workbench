//! 工作树差异。范围只含未提交、未暂存、已暂存。
//! 还没有提交的仓库不能对 `HEAD` 做 diff，改和空树比较。

use std::path::Path;
use std::process::{Command, Stdio};

const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
/// 空树的固定 id。没有提交时用它代替 `HEAD`，比较已进入索引的工作区内容。
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

pub fn git_diff_text(root: &Path, scope: &str, ignore_whitespace: bool) -> Result<String, String> {
    if !root.is_dir() {
        return Err("项目不存在".into());
    }
    let mut args = vec![
        "-c",
        "core.quotepath=false",
        "diff",
        "--no-ext-diff",
        "--no-color",
    ];
    if ignore_whitespace {
        args.push("-w");
    }
    match scope {
        "uncommitted" => {
            if !super::worktree::repo_has_commit(root)? {
                return unborn_uncommitted_diff(root, ignore_whitespace);
            }
            args.push("HEAD");
        }
        "unstaged" => {}
        "staged" => args.push("--cached"),
        "committed" | "branch" => return Err("这个范围没有可用的差异".into()),
        _ => return Err("不支持的差异范围".into()),
    }
    args.push("--");
    map_diff_output(&run_diff(root, &args)?)
}

/// 还没有提交时，`git diff HEAD` 会报 `bad revision 'HEAD'`。
/// 已进索引的内容对空树比较；未跟踪文件逐个对空设备做 `--no-index` 差异。
fn unborn_uncommitted_diff(root: &Path, ignore_whitespace: bool) -> Result<String, String> {
    let tracked = map_diff_output(&run_diff(
        root,
        &diff_args(ignore_whitespace, &[EMPTY_TREE, "--"]),
    )?)?;
    let mut combined = tracked;
    let listed = super::git_output(root, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    if !listed.status.success() {
        return Err(diff_stderr(&listed, "无法列出未跟踪文件"));
    }
    let names = crate::encoding::decode_child_bytes(&listed.stdout).into_owned();
    let null_path = if cfg!(windows) { "NUL" } else { "/dev/null" };
    for file in names.split('\0') {
        if file.is_empty() {
            continue;
        }
        let args = diff_args(ignore_whitespace, &["--no-index", "--", null_path, file]);
        let output = run_diff(root, &args)?;
        let code = output.status.code();
        let stdout = crate::encoding::decode_child_bytes(&output.stdout).into_owned();
        if output.status.success() || code == Some(1) {
            if stdout.is_empty() {
                let stderr = crate::encoding::decode_child_bytes(&output.stderr);
                let stderr = stderr.trim();
                if !stderr.is_empty() {
                    return Err(plain_diff_error(stderr));
                }
            }
            append_diff(&mut combined, &stdout)?;
            continue;
        }
        return Err(diff_stderr(&output, "git diff 失败"));
    }
    Ok(combined)
}

fn diff_args<'a>(ignore_whitespace: bool, tail: &[&'a str]) -> Vec<&'a str> {
    let mut args = vec![
        "-c",
        "core.quotepath=false",
        "diff",
        "--no-ext-diff",
        "--no-color",
    ];
    if ignore_whitespace {
        args.push("-w");
    }
    args.extend(tail);
    args
}

fn run_diff(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0");
    crate::encoding::apply_utf8_env_std(&mut command);
    super::hide_console(&mut command);
    command
        .output()
        .map_err(|err| format!("无法运行 git: {err}"))
}

fn map_diff_output(output: &std::process::Output) -> Result<String, String> {
    if !output.status.success() {
        return Err(diff_stderr(output, "git diff 失败"));
    }
    if output.stdout.len() > MAX_DIFF_BYTES {
        return Err("差异太大，无法完整显示".into());
    }
    Ok(crate::encoding::decode_child_bytes(&output.stdout).into_owned())
}

fn append_diff(combined: &mut String, stdout: &str) -> Result<(), String> {
    if combined.len().saturating_add(stdout.len()) > MAX_DIFF_BYTES {
        return Err("差异太大，无法完整显示".into());
    }
    combined.push_str(stdout);
    if !stdout.is_empty() && !stdout.ends_with('\n') {
        combined.push('\n');
    }
    Ok(())
}

fn diff_stderr(output: &std::process::Output, fallback: &str) -> String {
    let stderr = crate::encoding::decode_child_bytes(&output.stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        fallback.to_string()
    } else {
        plain_diff_error(stderr)
    }
}

fn plain_diff_error(stderr: &str) -> String {
    if stderr.contains("not a git repository") {
        "当前目录不是 git 仓库".to_string()
    } else {
        stderr.to_string()
    }
}


#[cfg(test)]
fn hide_for_test(command: &mut Command) {
    super::hide_console(command);
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::hide_for_test;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

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
        hide_for_test(&mut command);
        command
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[test]
    fn git_diff_follows_uncommitted_unstaged_and_staged() {
        let mut probe = Command::new("git");
        probe
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_for_test(&mut probe);
        if !probe
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return;
        }
        let root = scratch("git-scope");
        assert!(run_git(&root, &["init"]));
        assert!(run_git(
            &root,
            &["config", "user.email", "diff@example.com"]
        ));
        assert!(run_git(&root, &["config", "user.name", "diff"]));
        assert!(run_git(&root, &["config", "core.autocrlf", "false"]));
        fs::write(root.join("note.txt"), "one\n").unwrap();
        assert!(run_git(&root, &["add", "note.txt"]));
        assert!(run_git(
            &root,
            &["-c", "commit.gpgsign=false", "commit", "-m", "base"]
        ));

        fs::write(root.join("note.txt"), "two\n").unwrap();
        let unstaged = git_diff_text(&root, "unstaged", false).unwrap();
        assert!(unstaged.contains("+two"), "{unstaged}");
        assert!(git_diff_text(&root, "staged", false).unwrap().is_empty());
        assert!(git_diff_text(&root, "uncommitted", false)
            .unwrap()
            .contains("+two"));

        assert!(run_git(&root, &["add", "note.txt"]));
        assert!(git_diff_text(&root, "unstaged", false).unwrap().is_empty());
        let staged = git_diff_text(&root, "staged", false).unwrap();
        assert!(staged.contains("+two"), "{staged}");
        assert!(git_diff_text(&root, "committed", false)
            .unwrap_err()
            .contains("没有可用"));
        assert!(git_diff_text(&root, "branch", false)
            .unwrap_err()
            .contains("没有可用"));

        fs::write(root.join("note.txt"), "two \n").unwrap();
        assert!(run_git(&root, &["add", "note.txt"]));
        fs::write(root.join("note.txt"), "two\n").unwrap();
        let spaced = git_diff_text(&root, "unstaged", false).unwrap();
        assert!(spaced.contains('-') || spaced.contains('+'), "{spaced}");
        assert!(git_diff_text(&root, "unstaged", true)
            .unwrap()
            .trim()
            .is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn uncommitted_diff_lists_untracked_files_when_head_is_missing() {
        let mut probe = Command::new("git");
        probe
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_for_test(&mut probe);
        if !probe
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return;
        }
        let root = scratch("unborn");
        assert!(run_git(&root, &["init"]));
        fs::write(root.join("qa-untracked.txt"), "line one\nline two\n").unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub").join("nested.txt"), "nested\n").unwrap();

        let unborn = git_diff_text(&root, "uncommitted", false).unwrap();
        assert!(
            !unborn.contains("bad revision"),
            "empty repo must not mention HEAD: {unborn}"
        );
        assert!(unborn.contains("qa-untracked.txt"), "{unborn}");
        assert!(unborn.contains("+line one"), "{unborn}");
        assert!(unborn.contains("+line two"), "{unborn}");
        assert!(unborn.contains("sub/nested.txt"), "{unborn}");
        assert!(unborn.contains("+nested"), "{unborn}");

        assert!(run_git(
            &root,
            &["config", "user.email", "diff@example.com"]
        ));
        assert!(run_git(&root, &["config", "user.name", "diff"]));
        fs::write(root.join("tracked.txt"), "base\n").unwrap();
        assert!(run_git(&root, &["add", "tracked.txt"]));
        assert!(run_git(
            &root,
            &["-c", "commit.gpgsign=false", "commit", "-m", "base"]
        ));
        fs::write(root.join("tracked.txt"), "changed\n").unwrap();
        fs::write(root.join("still-untracked.txt"), "hidden\n").unwrap();
        let committed = git_diff_text(&root, "uncommitted", false).unwrap();
        assert!(committed.contains("+changed"), "{committed}");
        assert!(
            !committed.contains("still-untracked.txt"),
            "repos with commits keep ignoring untracked files: {committed}"
        );
        assert!(
            !committed.contains("+hidden"),
            "repos with commits keep ignoring untracked files: {committed}"
        );
        let _ = fs::remove_dir_all(root);
    }
}
