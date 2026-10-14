//! 审查目标：分支、未提交改动、提交列表。标题文案跟 TUI `review_popups.rs`。

use std::process::Stdio;

use tokio::process::Command;

use crate::encoding::decode_child_bytes;
use crate::models::{ReviewLabels, ReviewTargets};

use super::super::process::hide_console;

/// `review_popups.rs` 的标题和选项。
pub(in crate::features::agents::codex) fn review_labels(
    current_branch: Option<&str>,
) -> ReviewLabels {
    ReviewLabels {
        title: "Select a review preset".into(),
        base_branch: "Review against a base branch".into(),
        base_branch_hint: "(PR Style)".into(),
        uncommitted: "Review uncommitted changes".into(),
        commit: "Review a commit".into(),
        custom: "Custom review instructions".into(),
        branch_title: "Select a base branch".into(),
        branch_subtitle: format!(
            "Current branch: {}",
            current_branch.unwrap_or("(detached HEAD)")
        ),
        branch_search: "Type to search branches".into(),
        commit_title: "Select a commit to review".into(),
        commit_search: "Type to search commits".into(),
        custom_placeholder: "Type instructions and press Enter".into(),
    }
}

/// `git-utils/src/info.rs` 的 `local_git_branches`、`current_branch_name`、`recent_commits(100)`。
/// 官方在出错时返回空列表，不报错。
pub(in crate::features::agents::codex) async fn git_review_targets(cwd: &str) -> ReviewTargets {
    let mut branches: Vec<String> = git(
        cwd,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )
    .await
    .map(|text| {
        text.lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    })
    .unwrap_or_default();
    branches.sort_unstable();
    for candidate in ["main", "master"] {
        let refname = format!("refs/heads/{candidate}");
        if git(cwd, &["rev-parse", "--verify", "--quiet", &refname])
            .await
            .is_ok()
        {
            if let Some(pos) = branches.iter().position(|name| name == candidate) {
                let base = branches.remove(pos);
                branches.insert(0, base);
            }
            break;
        }
    }
    let current_branch = git(cwd, &["branch", "--show-current"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|name| !name.is_empty());
    let commits = if git(cwd, &["rev-parse", "--git-dir"]).await.is_ok() {
        git(
            cwd,
            &["log", "-n", "100", "--pretty=format:%H%x1f%ct%x1f%s"],
        )
        .await
        .map(|text| parse_commit_log(&text))
        .unwrap_or_default()
    } else {
        Vec::new()
    };
    ReviewTargets {
        branches,
        commits,
        error: None,
        labels: review_labels(current_branch.as_deref()),
        current_branch,
    }
}

pub(super) fn parse_commit_log(text: &str) -> Vec<crate::models::ReviewCommit> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split('\u{001f}');
            let sha = parts.next().unwrap_or("").trim();
            let ts = parts.next().unwrap_or("").trim();
            let subject = parts.next().unwrap_or("").trim();
            if sha.is_empty() || ts.is_empty() {
                return None;
            }
            Some(crate::models::ReviewCommit {
                sha: sha.to_string(),
                title: subject.to_string(),
            })
        })
        .collect()
}

async fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg("core.hooksPath=".to_string() + if cfg!(windows) { "NUL" } else { "/dev/null" })
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_console(&mut command);
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
        .await
        .map_err(|_| "git timed out".to_string())?
        .map_err(|err| err.to_string())?;
    if output.status.success() {
        return Ok(decode_child_bytes(&output.stdout).into_owned());
    }
    Err(decode_child_bytes(&output.stderr).trim().to_string())
}
