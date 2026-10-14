//! 回合 diff。Claude Code 的 stream-json 没有 Codex 那种 `turn/diff` 事件。
//!
//! 优先级：
//! 1. 工具结果里已经带的 `diff` / `patch` / `structuredPatch`（CLI 自己算的）。
//! 2. `Edit` 的 `old_string`/`new_string`，或 `Write` 的 `content`，用 diffy 拼统一 diff。
//! 3. 只有路径、没有正文时，对该路径做 `git diff -- <path>`。不做整仓 diff，
//!    避免把与这一轮无关的脏文件算进来。git 范围（未提交/未暂存/已暂存）仍走协议层的 git。

use std::path::Path;
use std::process::Command;

use serde_json::Value;

use crate::models::{FileChange, FileStatus};

const EDIT_TOOLS: &[&str] = &["Edit", "Write", "NotebookEdit", "MultiEdit"];

pub fn changes_for_tool(
    project: Option<&Path>,
    tool_name: &str,
    input: &Value,
    result: Option<&Value>,
) -> Vec<FileChange> {
    if let Some(result) = result {
        if let Some(change) = change_from_result(tool_name, input, result) {
            return vec![change];
        }
    }
    if let Some(change) = change_from_input(tool_name, input) {
        return vec![change];
    }
    let Some(path) = tool_path(input).filter(|path| !path.is_empty()) else {
        return Vec::new();
    };
    if !EDIT_TOOLS.contains(&tool_name) && result.is_none() {
        return Vec::new();
    }
    let Some(project) = project else {
        return Vec::new();
    };
    git_file_change(project, &path).into_iter().collect()
}

fn change_from_result(tool_name: &str, input: &Value, result: &Value) -> Option<FileChange> {
    let path = tool_path(input).unwrap_or_default();
    if let Some(patch) = structured_patch(result) {
        return Some(file_change(path_or_unknown(&path), &patch));
    }
    let text = result_text(result);
    if looks_like_diff(&text) {
        return Some(file_change(path_or_unknown(&path), &text));
    }
    let _ = tool_name;
    None
}

fn change_from_input(tool_name: &str, input: &Value) -> Option<FileChange> {
    if !EDIT_TOOLS.contains(&tool_name) {
        return None;
    }
    let path = tool_path(input)?;
    if path.is_empty() {
        return None;
    }
    let (old, new) = match tool_name {
        "Write" => {
            let content = input.get("content").and_then(Value::as_str)?;
            (String::new(), content.to_string())
        }
        _ => {
            let old = input.get("old_string").and_then(Value::as_str);
            let new = input.get("new_string").and_then(Value::as_str);
            if old.is_none() && new.is_none() {
                return None;
            }
            (old.unwrap_or("").to_string(), new.unwrap_or("").to_string())
        }
    };
    let patch = unified_diff(&path, &old, &new);
    Some(file_change(path, &patch))
}

pub fn unified_diff(path: &str, old: &str, new: &str) -> String {
    let raw = diffy::create_patch(old, new).to_string();
    let old_header = format!("--- a/{path}");
    let new_header = format!("+++ b/{path}");
    raw.replacen("--- original", &old_header, 1)
        .replacen("+++ modified", &new_header, 1)
}

fn file_change(path: String, diff: &str) -> FileChange {
    let (added, removed) = count_hunks(diff);
    let status = if removed == 0 && added > 0 && !diff.contains("\n-") && !diff.contains("\n---") {
        FileStatus::Added
    } else if added == 0 && removed > 0 {
        FileStatus::Deleted
    } else if diff.starts_with("--- /dev/null") || diff.contains("\n--- /dev/null") {
        FileStatus::Added
    } else if diff.contains("\n+++ /dev/null") {
        FileStatus::Deleted
    } else {
        FileStatus::Modified
    };
    FileChange {
        path,
        status,
        added,
        removed,
        diff: diff.to_string(),
    }
}

fn count_hunks(diff: &str) -> (u32, u32) {
    let mut added = 0u32;
    let mut removed = 0u32;
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            added = added.saturating_add(1);
        } else if line.starts_with('-') {
            removed = removed.saturating_add(1);
        }
    }
    (added, removed)
}

fn tool_path(input: &Value) -> Option<String> {
    for key in ["file_path", "path", "planFilePath"] {
        if let Some(path) = input.get(key).and_then(Value::as_str) {
            let path = path.trim();
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    None
}

fn path_or_unknown(path: &str) -> String {
    if path.is_empty() {
        "unknown".to_string()
    } else {
        path.to_string()
    }
}

fn looks_like_diff(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("diff --git")
        || trimmed.starts_with("--- ")
        || trimmed.starts_with("@@")
}

fn result_text(result: &Value) -> String {
    if let Some(text) = result.as_str() {
        return text.to_string();
    }
    for key in ["diff", "patch", "content"] {
        if let Some(text) = result.get(key).and_then(Value::as_str) {
            if looks_like_diff(text) || key != "content" {
                return text.to_string();
            }
        }
    }
    if let Some(blocks) = result.as_array() {
        return blocks.iter().filter_map(block_text).collect::<Vec<_>>().join("\n");
    }
    if let Some(content) = result.get("content") {
        return result_text(content);
    }
    String::new()
}

fn block_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    value.get("text").and_then(Value::as_str).map(str::to_string)
}

fn structured_patch(result: &Value) -> Option<String> {
    let patch = result
        .get("structuredPatch")
        .or_else(|| result.get("content").and_then(|content| content.get("structuredPatch")))?;
    let items = patch.as_array()?;
    if items.is_empty() {
        return None;
    }
    let mut out = String::new();
    for hunk in items {
        let old_start = hunk.get("oldStart").and_then(Value::as_i64).unwrap_or(1);
        let old_lines = hunk.get("oldLines").and_then(Value::as_i64).unwrap_or(0);
        let new_start = hunk.get("newStart").and_then(Value::as_i64).unwrap_or(1);
        let new_lines = hunk.get("newLines").and_then(Value::as_i64).unwrap_or(0);
        out.push_str(&format!("@@ -{old_start},{old_lines} +{new_start},{new_lines} @@\n"));
        if let Some(lines) = hunk.get("lines").and_then(Value::as_array) {
            for line in lines {
                if let Some(text) = line.as_str() {
                    out.push_str(text);
                    if !text.ends_with('\n') {
                        out.push('\n');
                    }
                }
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn git_file_change(project: &Path, path: &str) -> Option<FileChange> {
    let unstaged = git_diff(project, &["diff", "--", path]);
    let diff = if unstaged.trim().is_empty() {
        git_diff(project, &["diff", "--cached", "--", path])
    } else {
        unstaged
    };
    if diff.trim().is_empty() {
        return None;
    }
    Some(file_change(path.to_string(), &diff))
}

fn git_diff(project: &Path, args: &[&str]) -> String {
    let Ok(output) = Command::new("git").args(args).current_dir(project).output() else {
        return String::new();
    };
    if !output.status.success() {
        return String::new();
    }
    String::from_utf8_lossy(&output.stdout).to_string()
}
