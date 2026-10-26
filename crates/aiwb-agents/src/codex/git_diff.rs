//! `/diff`：移植 openai/codex rust-v0.162.1 `tui/src/get_git_diff.rs`
//! 与 `git-utils/src/fsmonitor.rs::detect_fsmonitor_override`。
//!
//! 已跟踪变更 + 每个未跟踪文件对 `/dev/null`（Windows 为 `NUL`）的 `--no-index` diff。
//! 与 TUI 唯一的差别：时间线按纯文本显示，所以不带 `--color`。

use std::path::Path;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use aiwb_proc::{apply_utf8_env, decode_child_bytes};

use super::process::hide_console;

const DIFF_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const SAFE_BARE_REPOSITORY_CONFIG: &str = "safe.bareRepository=explicit";
const DISABLE_HOOKS_CONFIG: &str = if cfg!(windows) {
    "core.hooksPath=NUL"
} else {
    "core.hooksPath=/dev/null"
};
const EXECUTABLE_FILTER_CONFIG_PATTERN: &str = r"^filter\..*\.(clean|process)$";
const DIFF_ARGS: [&str; 5] = [
    "diff",
    "--no-textconv",
    "--no-ext-diff",
    "--submodule=short",
    "--ignore-submodules=dirty",
];

/// TUI `slash_dispatch.rs` 与 `event_dispatch.rs::DiffResult` 的显示文本。
pub(super) async fn diff_text(cwd: &Path) -> String {
    match get_git_diff(cwd).await {
        Ok((false, _)) => "`/diff` — _not inside a git repository_".to_string(),
        Ok((true, text)) if text.trim().is_empty() => "No changes detected.".to_string(),
        Ok((true, text)) => text,
        Err(err) => format!("Failed to compute diff: {err}"),
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Fsmonitor {
    Disabled,
    BuiltIn,
}

impl Fsmonitor {
    fn git_config_arg(self) -> &'static str {
        match self {
            Self::Disabled => "core.fsmonitor=false",
            Self::BuiltIn => "core.fsmonitor=true",
        }
    }
}

struct Output {
    code: i32,
    stdout: Vec<u8>,
}

pub(super) async fn get_git_diff(cwd: &Path) -> Result<(bool, String), String> {
    let inside = run(cwd, Fsmonitor::Disabled, &[], &["rev-parse", "--is-inside-work-tree"]).await?;
    if inside.code != 0 {
        return Ok((false, String::new()));
    }
    let fsmonitor = detect_fsmonitor(cwd).await;
    let overrides = filter_overrides(cwd, fsmonitor).await?;
    let (tracked, untracked) = tokio::join!(
        capture_diff(cwd, fsmonitor, &overrides, &DIFF_ARGS),
        capture_stdout(cwd, fsmonitor, &["ls-files", "--others", "--exclude-standard"]),
    );
    let tracked = tracked?;
    let untracked = untracked?;
    let null_path = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut untracked_diff = String::new();
    for file in untracked.split('\n') {
        let file = file.trim_end_matches('\r');
        if file.is_empty() {
            continue;
        }
        let mut args = DIFF_ARGS.to_vec();
        args.extend(["--no-index", "--", null_path, file]);
        untracked_diff.push_str(&capture_diff(cwd, fsmonitor, &overrides, &args).await?);
    }
    Ok((true, format!("{tracked}{untracked_diff}")))
}

async fn capture_stdout(cwd: &Path, fsmonitor: Fsmonitor, args: &[&str]) -> Result<String, String> {
    let output = run(cwd, fsmonitor, &[], args).await?;
    if output.code == 0 {
        Ok(decode_child_bytes(&output.stdout).into_owned())
    } else {
        Err(format!("git {:?} failed with status {}", args, output.code))
    }
}

/// git diff 有差异时退出码是 1，也算成功。
async fn capture_diff(
    cwd: &Path,
    fsmonitor: Fsmonitor,
    overrides: &[(String, String)],
    args: &[&str],
) -> Result<String, String> {
    let output = run(cwd, fsmonitor, overrides, args).await?;
    if output.code == 0 || output.code == 1 {
        Ok(decode_child_bytes(&output.stdout).into_owned())
    } else {
        Err(format!("git {:?} failed with status {}", args, output.code))
    }
}

/// 让仓库里配置的 clean / process 过滤器在生成 diff 时不执行。
async fn filter_overrides(cwd: &Path, fsmonitor: Fsmonitor) -> Result<Vec<(String, String)>, String> {
    let args = [
        "config",
        "--null",
        "--name-only",
        "--get-regexp",
        EXECUTABLE_FILTER_CONFIG_PATTERN,
    ];
    let output = run(cwd, fsmonitor, &[], &args).await?;
    if output.code != 0 && output.code != 1 {
        return Err(format!("git {:?} failed with status {}", args, output.code));
    }
    let text = decode_child_bytes(&output.stdout).into_owned();
    Ok(filter_drivers(&text)
        .into_iter()
        .flat_map(|driver| {
            [
                (format!("{driver}.clean"), String::new()),
                (format!("{driver}.process"), String::new()),
                (format!("{driver}.required"), "false".to_string()),
            ]
        })
        .collect())
}

fn filter_drivers(stdout: &str) -> Vec<String> {
    let mut drivers = stdout
        .split('\0')
        .filter_map(|key| {
            key.strip_suffix(".clean")
                .or_else(|| key.strip_suffix(".process"))
        })
        .map(str::to_string)
        .collect::<Vec<_>>();
    drivers.sort();
    drivers.dedup();
    drivers
}

async fn probe(cwd: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg(SAFE_BARE_REPOSITORY_CONFIG)
        .args(args)
        .current_dir(cwd);
    let output = spawn(command).await.ok()?;
    (output.code == 0).then_some(output.stdout)
}

async fn detect_fsmonitor(cwd: &Path) -> Fsmonitor {
    let Some(config) = probe(cwd, &["config", "--null", "--get", "core.fsmonitor"]).await else {
        return Fsmonitor::Disabled;
    };
    let Some(config) = config.strip_suffix(b"\0") else {
        return Fsmonitor::Disabled;
    };
    if config.contains(&0) {
        return Fsmonitor::Disabled;
    }
    let Ok(config) = std::str::from_utf8(config) else {
        return Fsmonitor::Disabled;
    };
    let configured = if ["true", "yes", "on"].iter().any(|v| config.eq_ignore_ascii_case(v)) {
        true
    } else if ["false", "no", "off"].iter().any(|v| config.eq_ignore_ascii_case(v)) {
        false
    } else {
        let typed = [
            "config",
            "--null",
            "--type=bool",
            "--fixed-value",
            "--get",
            "core.fsmonitor",
            config,
        ];
        matches!(probe(cwd, &typed).await.as_deref(), Some(b"true\0"))
    };
    if !configured {
        return Fsmonitor::Disabled;
    }
    let Some(build) = probe(cwd, &["version", "--build-options"]).await else {
        return Fsmonitor::Disabled;
    };
    if build
        .split(|byte| *byte == b'\n')
        .any(|line| line.trim_ascii() == b"feature: fsmonitor--daemon")
    {
        Fsmonitor::BuiltIn
    } else {
        Fsmonitor::Disabled
    }
}

async fn run(
    cwd: &Path,
    fsmonitor: Fsmonitor,
    overrides: &[(String, String)],
    args: &[&str],
) -> Result<Output, String> {
    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg(SAFE_BARE_REPOSITORY_CONFIG)
        .arg("-c")
        .arg(fsmonitor.git_config_arg())
        .arg("-c")
        .arg(DISABLE_HOOKS_CONFIG)
        .args(args)
        .current_dir(cwd);
    if !overrides.is_empty() {
        command.env("GIT_CONFIG_COUNT", overrides.len().to_string());
        for (index, (key, value)) in overrides.iter().enumerate() {
            command
                .env(format!("GIT_CONFIG_KEY_{index}"), key)
                .env(format!("GIT_CONFIG_VALUE_{index}"), value);
        }
    }
    spawn(command).await
}

async fn spawn(mut command: Command) -> Result<Output, String> {
    apply_utf8_env(&mut command);
    hide_console(&mut command);
    command.kill_on_drop(true);
    let output = timeout(DIFF_COMMAND_TIMEOUT, command.output())
        .await
        .map_err(|_| "git timed out".to_string())?
        .map_err(|err| err.to_string())?;
    Ok(Output {
        code: output.status.code().unwrap_or(-1),
        stdout: output.stdout,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?}");
    }

    #[test]
    fn filter_drivers_are_deduplicated() {
        assert_eq!(
            filter_drivers("filter.lfs.clean\0filter.lfs.process\0filter.x.clean\0"),
            ["filter.lfs", "filter.x"]
        );
    }

    #[tokio::test]
    async fn tracked_and_untracked_changes_follow_the_tui() {
        let root = std::env::temp_dir().join(format!("aiw-diff-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(diff_text(&root).await, "`/diff` — _not inside a git repository_");
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.email", "t@example.com"]);
        git(&root, &["config", "user.name", "t"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&root, &["add", "a.txt"]);
        git(&root, &["commit", "-qm", "seed"]);
        assert_eq!(diff_text(&root).await, "No changes detected.");
        std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(root.join("new.txt"), "fresh\n").unwrap();
        let text = diff_text(&root).await;
        assert!(text.contains("diff --git a/a.txt b/a.txt"), "{text}");
        assert!(text.contains("+two"), "{text}");
        assert!(text.contains("new.txt"), "{text}");
        assert!(text.contains("+fresh"), "{text}");
        assert!(!text.contains("\u{1b}["), "plain text only");
        let _ = std::fs::remove_dir_all(&root);
    }
}
