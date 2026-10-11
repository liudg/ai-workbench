//! 工作树差异。范围只含未提交、未暂存、已暂存；已提交和分支的子菜单没有观察到。

use std::path::Path;
use std::process::{Command, Stdio};

const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

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
        "uncommitted" => args.push("HEAD"),
        "unstaged" => {}
        "staged" => args.push("--cached"),
        "committed" | "branch" => return Err("这个范围没有可用的差异".into()),
        _ => return Err("不支持的差异范围".into()),
    }
    args.push("--");

    let mut command = Command::new("git");
    command
        .args(&args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0");
    crate::encoding::apply_utf8_env_std(&mut command);
    hide_console(&mut command);
    let output = command
        .output()
        .map_err(|err| format!("无法运行 git: {err}"))?;
    if !output.status.success() {
        let stderr = crate::encoding::decode_child_bytes(&output.stderr);
        let stderr = stderr.trim();
        if stderr.contains("not a git repository") {
            return Err("当前目录不是 git 仓库".into());
        }
        if stderr.is_empty() {
            return Err("git diff 失败".into());
        }
        return Err(stderr.to_string());
    }
    if output.stdout.len() > MAX_DIFF_BYTES {
        return Err("差异太大，无法完整显示".into());
    }
    Ok(crate::encoding::decode_child_bytes(&output.stdout).into_owned())
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
        let dir = std::env::temp_dir().join(format!(
            "ai-workbench-git-{name}-{}",
            std::process::id()
        ));
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
        command.status().map(|status| status.success()).unwrap_or(false)
    }

    #[test]
    fn git_diff_follows_uncommitted_unstaged_and_staged() {
        let mut probe = Command::new("git");
        probe.arg("--version").stdout(Stdio::null()).stderr(Stdio::null());
        hide_console(&mut probe);
        if !probe.status().map(|status| status.success()).unwrap_or(false) {
            return;
        }
        let root = scratch("git-scope");
        assert!(run_git(&root, &["init"]));
        assert!(run_git(&root, &["config", "user.email", "diff@example.com"]));
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
        assert!(git_diff_text(&root, "uncommitted", false).unwrap().contains("+two"));

        assert!(run_git(&root, &["add", "note.txt"]));
        assert!(git_diff_text(&root, "unstaged", false).unwrap().is_empty());
        let staged = git_diff_text(&root, "staged", false).unwrap();
        assert!(staged.contains("+two"), "{staged}");
        assert!(git_diff_text(&root, "committed", false).unwrap_err().contains("没有可用"));
        assert!(git_diff_text(&root, "branch", false).unwrap_err().contains("没有可用"));

        fs::write(root.join("note.txt"), "two \n").unwrap();
        assert!(run_git(&root, &["add", "note.txt"]));
        fs::write(root.join("note.txt"), "two\n").unwrap();
        let spaced = git_diff_text(&root, "unstaged", false).unwrap();
        assert!(spaced.contains('-') || spaced.contains('+'), "{spaced}");
        assert!(git_diff_text(&root, "unstaged", true).unwrap().trim().is_empty());
        let _ = fs::remove_dir_all(root);
    }
}
