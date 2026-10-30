//! 回合 diff。Claude Code 的 stream-json 没有 Codex 那种 `turn/diff` 事件。
//!
//! 优先级：
//! 1. 工具结果里已经带的 `diff` / `patch` / `structuredPatch`（CLI 自己算的）。
//! 2. `Edit` 的 `old_string`/`new_string`，或 `Write` 的 `content`，用 diffy 拼统一 diff。
//! 3. 只有路径、没有正文时，对该路径做 `git diff -- <path>`。不做整仓 diff，
//!    避免把与这一轮无关的脏文件算进来。git 范围（未提交/未暂存/已暂存）仍走协议层的 git。
//!
//! 一轮的累计 diff 照 Codex `core/src/turn_diff_tracker.rs`：文件这一轮第一次被改时记下原文，
//! 之后每次都拿原文和改后的全文比。原文和改后全文都从工具结果的 `originalFile` 推出来，
//! 回放历史时磁盘早已变了也算得对。

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use serde_json::Value;

use crate::changes::unified_diff;
use aiwb_core::models::{FileChange, FileStatus};

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

/// 这一轮里每个文件第一次被改之前的全文。`None` 是这一轮新建的文件。
#[derive(Default)]
pub struct TurnBaselines {
    files: HashMap<String, Option<String>>,
}

impl TurnBaselines {
    pub fn clear(&mut self) {
        self.files.clear();
    }

    /// 这一轮到目前为止这个文件的累计变更。工具结果里没有原文、或改后全文推不出来时为 `None`。
    pub fn turn_change(&mut self, tool_name: &str, input: &Value, structured: Option<&Value>) -> Option<FileChange> {
        let structured = structured?;
        let path = tool_path(input)?;
        // 一条消息里有几个工具结果时，结构化结果只对得上其中一个。路径对不上就不用。
        if let Some(reported) = structured.get("filePath").and_then(Value::as_str) {
            if !same_path(reported, &path) {
                return None;
            }
        }
        let before = match structured.get("originalFile")? {
            Value::String(text) => Some(text.clone()),
            Value::Null => None,
            _ => return None,
        };
        let after = content_after(tool_name, input, structured, before.as_deref())?;
        let baseline = self.files.entry(path.clone()).or_insert(before).clone();
        let patch = unified_diff(&path, baseline.as_deref().unwrap_or(""), &after);
        let (added, removed) = count_hunks(&patch);
        let status = match (&baseline, after.is_empty()) {
            (None, _) => FileStatus::Added,
            (Some(_), true) => FileStatus::Deleted,
            _ => FileStatus::Modified,
        };
        Some(FileChange {
            path,
            status,
            added,
            removed,
            diff: patch,
        })
    }
}

fn same_path(left: &str, right: &str) -> bool {
    let norm = |path: &str| path.replace('\\', "/").to_lowercase();
    norm(left) == norm(right)
}

/// 这次工具调用之后的全文。`Write` 结果直接带；`Edit` / `MultiEdit` 在原文上照做一遍替换。
fn content_after(tool_name: &str, input: &Value, structured: &Value, before: Option<&str>) -> Option<String> {
    if tool_name == "Write" {
        return structured
            .get("content")
            .or_else(|| input.get("content"))
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    let mut text = before?.to_string();
    let edits: Vec<&Value> = match input.get("edits").and_then(Value::as_array) {
        Some(edits) if tool_name == "MultiEdit" => edits.iter().collect(),
        _ if tool_name == "Edit" => vec![input],
        _ => return None,
    };
    for edit in edits {
        let old = edit.get("old_string").and_then(Value::as_str)?;
        let new = edit.get("new_string").and_then(Value::as_str)?;
        if old.is_empty() || !text.contains(old) {
            return None;
        }
        let all = edit.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
        text = if all { text.replace(old, new) } else { text.replacen(old, new, 1) };
    }
    Some(text)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const EIGHT: &str = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n";

    #[test]
    fn two_edits_in_one_turn_diff_against_the_first_original() {
        let mut baselines = TurnBaselines::default();
        let path = "C:/p/a.txt";
        let first = baselines
            .turn_change(
                "Edit",
                &json!({ "file_path": path, "old_string": "line2", "new_string": "TWO" }),
                Some(&json!({ "originalFile": EIGHT })),
            )
            .expect("first edit");
        assert_eq!((first.added, first.removed), (1, 1));
        let second = baselines
            .turn_change(
                "Edit",
                &json!({ "file_path": path, "old_string": "line7", "new_string": "SEVEN" }),
                Some(&json!({ "originalFile": EIGHT.replace("line2", "TWO") })),
            )
            .expect("second edit");
        assert_eq!(second.status, FileStatus::Modified);
        assert_eq!((second.added, second.removed), (2, 2));
        assert!(second.diff.contains("-line2\n+TWO"));
        assert!(second.diff.contains("-line7\n+SEVEN"));
    }

    #[test]
    fn a_file_written_then_edited_stays_added() {
        let mut baselines = TurnBaselines::default();
        baselines
            .turn_change(
                "Write",
                &json!({ "file_path": "new.txt", "content": "a\nb\n" }),
                Some(&json!({ "type": "create", "content": "a\nb\n", "originalFile": null })),
            )
            .expect("write");
        let edited = baselines
            .turn_change(
                "Edit",
                &json!({ "file_path": "new.txt", "old_string": "b", "new_string": "c" }),
                Some(&json!({ "originalFile": "a\nb\n" })),
            )
            .expect("edit");
        assert_eq!(edited.status, FileStatus::Added);
        assert_eq!((edited.added, edited.removed), (2, 0));
        assert!(edited.diff.contains("+c"));
    }

    #[test]
    fn a_change_back_to_the_original_leaves_an_empty_diff() {
        let mut baselines = TurnBaselines::default();
        let input = |old: &str, new: &str| json!({ "file_path": "x.txt", "old_string": old, "new_string": new });
        baselines.turn_change("Edit", &input("a", "b"), Some(&json!({ "originalFile": "a\n" })));
        let back = baselines
            .turn_change("Edit", &input("b", "a"), Some(&json!({ "originalFile": "b\n" })))
            .expect("revert");
        assert_eq!((back.added, back.removed), (0, 0));
    }

    #[test]
    fn multi_edit_applies_every_replacement() {
        let mut baselines = TurnBaselines::default();
        let change = baselines
            .turn_change(
                "MultiEdit",
                &json!({ "file_path": "m.txt", "edits": [
                    { "old_string": "line1", "new_string": "ONE" },
                    { "old_string": "line8", "new_string": "EIGHT" }
                ] }),
                Some(&json!({ "originalFile": EIGHT })),
            )
            .expect("multi edit");
        assert_eq!((change.added, change.removed), (2, 2));
    }

    #[test]
    fn missing_original_falls_back() {
        let mut baselines = TurnBaselines::default();
        let input = json!({ "file_path": "x.txt", "old_string": "a", "new_string": "b" });
        assert!(baselines.turn_change("Edit", &input, None).is_none());
        assert!(baselines.turn_change("Edit", &input, Some(&json!({}))).is_none());
    }
}

