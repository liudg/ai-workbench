//! 把各适配器的补丁归一成 `file-change` / `turn-changes`。
//! 实时通知和历史回放都走这里，不再为了旧前端把事件改名成 `apply_patch`。

use serde_json::Value;

use crate::models::{FileChange, FileStatus, SessionEventBody};

pub fn file_changes_from_codex(changes: &Value) -> Vec<FileChange> {
    if let Some(list) = changes.as_array() {
        return list.iter().filter_map(file_change_from_value).collect();
    }
    let Some(map) = changes.as_object() else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(path, change)| {
            let mut change = change.clone();
            if let Some(obj) = change.as_object_mut() {
                obj.entry("path")
                    .or_insert_with(|| Value::String(path.clone()));
            }
            file_change_from_value(&change)
        })
        .collect()
}

pub fn file_change_from_value(change: &Value) -> Option<FileChange> {
    let path = change
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())?;
    let kind = change_kind(change);
    let mut diff = change_diff(change, &kind.name);
    if !kind.move_path.is_empty() {
        let suffix = format!("\n\nMoved to: {}", kind.move_path);
        if let Some(stripped) = diff.strip_suffix(&suffix) {
            diff.truncate(stripped.len());
        }
    }
    let (added, removed) = line_counts(&kind.name, &diff);
    let mut path = display_path(path);
    let mut status = file_status(&kind.name);
    if !kind.move_path.is_empty() {
        status = FileStatus::Renamed;
        path = display_path(&kind.move_path);
    }
    Some(FileChange {
        path,
        status,
        added,
        removed,
        diff,
    })
}

/// 同一路径后来的空 diff 不能把已经从 hunk / patch 算出来的行数清掉。
pub fn merge_file_list(existing: &[FileChange], incoming: &[FileChange]) -> Vec<FileChange> {
    let mut out = existing.to_vec();
    for file in incoming {
        if let Some(slot) = out
            .iter_mut()
            .find(|item| same_file(&item.path, &file.path))
        {
            *slot = merge_file_change(slot, file);
        } else {
            out.push(file.clone());
        }
    }
    out
}

pub fn merge_file_change(existing: &FileChange, incoming: &FileChange) -> FileChange {
    if incoming.diff.trim().is_empty() && !existing.diff.trim().is_empty() {
        existing.clone()
    } else {
        incoming.clone()
    }
}

/// 逐文件补丁没有正文时，用回合统一 diff 补上 added/removed。
pub fn overlay_unified_diff(files: &[FileChange], diff: &str) -> Vec<FileChange> {
    let parsed = parse_unified_files(diff);
    if parsed.is_empty() {
        return files.to_vec();
    }
    if files.is_empty() {
        return parsed;
    }
    let mut out = files.to_vec();
    for file in parsed {
        if let Some(slot) = out
            .iter_mut()
            .find(|item| same_file(&item.path, &file.path))
        {
            if slot.diff.trim().is_empty() {
                slot.added = file.added;
                slot.removed = file.removed;
                slot.diff = file.diff;
                if slot.status == FileStatus::Modified {
                    slot.status = file.status;
                }
            }
        } else {
            out.push(file);
        }
    }
    out
}

pub fn sync_file_change_counts(
    bodies: &mut [SessionEventBody],
    turn_id: &str,
    files: &[FileChange],
) {
    for body in bodies {
        let SessionEventBody::FileChange {
            turn_id: event_turn,
            path,
            status,
            added,
            removed,
            diff,
        } = body
        else {
            continue;
        };
        if event_turn != turn_id {
            continue;
        }
        let Some(file) = files.iter().find(|file| same_file(&file.path, path)) else {
            continue;
        };
        *status = file.status;
        *added = file.added;
        *removed = file.removed;
        *diff = file.diff.clone();
    }
}

pub fn same_file(left: &str, right: &str) -> bool {
    let left = display_path(left).to_ascii_lowercase();
    let right = display_path(right).to_ascii_lowercase();
    if left.is_empty() || right.is_empty() {
        return false;
    }
    if left == right {
        return true;
    }
    let (short, long) = if left.len() <= right.len() {
        (left.as_str(), right.as_str())
    } else {
        (right.as_str(), left.as_str())
    };
    long.len() > short.len()
        && long.as_bytes()[long.len() - short.len() - 1] == b'/'
        && long.ends_with(short)
}

pub fn parse_unified_files(diff: &str) -> Vec<FileChange> {
    let mut files = Vec::new();
    let mut current: Option<Draft> = None;
    for line in diff.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.starts_with("diff --git ") {
            flush_draft(&mut current, &mut files);
            current = Some(draft_from_git_header(line));
            continue;
        }
        if current.is_none() && (line.starts_with("--- ") || line.starts_with("+++ ")) {
            current = Some(Draft::default());
        }
        let Some(draft) = current.as_mut() else {
            continue;
        };
        draft.lines.push(line.to_string());
        if let Some(path) = line.strip_prefix("--- ") {
            draft.old_path = unquote(path.trim());
        } else if let Some(path) = line.strip_prefix("+++ ") {
            draft.new_path = unquote(path.trim());
        } else if let Some(path) = line.strip_prefix("rename to ") {
            draft.rename_to = path.trim().to_string();
        } else if line.starts_with("rename from ") {
            draft.renamed = true;
        } else if line.starts_with("new file") {
            draft.added_file = true;
        } else if line.starts_with("deleted file") {
            draft.deleted_file = true;
        } else if line.starts_with('+') && !line.starts_with("+++") {
            draft.added += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            draft.removed += 1;
        }
    }
    flush_draft(&mut current, &mut files);
    files
}

pub fn push_file_change_events(
    bodies: &mut Vec<SessionEventBody>,
    turn_id: &str,
    files: &[FileChange],
) {
    if files.is_empty() {
        return;
    }
    for file in files {
        bodies.push(SessionEventBody::FileChange {
            turn_id: turn_id.to_string(),
            path: file.path.clone(),
            status: file.status,
            added: file.added,
            removed: file.removed,
            diff: file.diff.clone(),
        });
    }
    bodies.push(SessionEventBody::TurnChanges {
        turn_id: turn_id.to_string(),
        files: files.to_vec(),
    });
}

pub fn file_status(kind: &str) -> FileStatus {
    match kind.trim().to_ascii_lowercase().as_str() {
        "a" | "add" | "added" | "create" | "created" => FileStatus::Added,
        "d" | "delete" | "deleted" | "remove" | "removed" => FileStatus::Deleted,
        "r" | "rename" | "renamed" | "move" | "moved" => FileStatus::Renamed,
        _ => FileStatus::Modified,
    }
}

struct ChangeKind {
    name: String,
    move_path: String,
}

fn change_kind(change: &Value) -> ChangeKind {
    let Some(raw) = change
        .get("kind")
        .or_else(|| change.get("type"))
        .or_else(|| change.get("status"))
    else {
        return ChangeKind {
            name: String::new(),
            move_path: String::new(),
        };
    };
    let mut kind = if let Some(text) = raw.as_str() {
        ChangeKind {
            name: text.to_string(),
            move_path: String::new(),
        }
    } else {
        ChangeKind {
            name: raw
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            move_path: raw
                .get("move_path")
                .or_else(|| raw.get("movePath"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        }
    };
    if kind.move_path.is_empty() {
        if let Some(text) = change
            .get("move_path")
            .or_else(|| change.get("movePath"))
            .and_then(Value::as_str)
        {
            kind.move_path = text.to_string();
        }
    }
    kind
}

fn change_diff(change: &Value, kind: &str) -> String {
    // 官方 FileChange::Add/Delete 带的是文件正文，不是 unified diff。
    if is_add_kind(kind) || is_delete_kind(kind) {
        if let Some(text) = nonempty_text(change, &["content"]) {
            return text;
        }
        if let Some(nested) = change.get("kind").filter(|value| value.is_object()) {
            if let Some(text) = nonempty_text(
                nested,
                &["content", "diff", "unifiedDiff", "unified_diff", "patch"],
            ) {
                return text;
            }
        }
    }
    let mut empty = String::new();
    for key in ["diff", "unifiedDiff", "unified_diff", "patch"] {
        let Some(text) = change.get(key).and_then(Value::as_str) else {
            continue;
        };
        if !text.is_empty() {
            return text.to_string();
        }
        if empty.is_empty() {
            empty = text.to_string();
        }
    }
    empty
}

/// TUI `diff_render.rs::line_counts`：新增文件按内容行数算 +，删除文件按内容行数算 -，
/// 其余用 `calculate_add_remove_from_diff`（diffy 解析 hunk，解析不了就是 0/0）。
fn is_add_kind(kind: &str) -> bool {
    matches!(
        kind.trim().to_ascii_lowercase().as_str(),
        "a" | "add" | "added" | "create" | "created"
    )
}

fn is_delete_kind(kind: &str) -> bool {
    matches!(
        kind.trim().to_ascii_lowercase().as_str(),
        "d" | "delete" | "deleted" | "remove" | "removed"
    )
}

fn nonempty_text(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        let Some(text) = value.get(*key).and_then(Value::as_str) else {
            continue;
        };
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }
    None
}

fn line_counts(kind: &str, diff: &str) -> (u32, u32) {
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    if is_add_kind(kind) {
        return (count(diff.lines().count()), 0);
    }
    if is_delete_kind(kind) {
        return (0, count(diff.lines().count()));
    }
    let (added, removed) = calculate_add_remove_from_diff(diff);
    (count(added), count(removed))
}

pub fn calculate_add_remove_from_diff(diff: &str) -> (usize, usize) {
    match diffy::Patch::from_str(diff) {
        Ok(patch) => patch
            .hunks()
            .iter()
            .flat_map(diffy::Hunk::lines)
            .fold((0, 0), |(a, d), line| match line {
                diffy::Line::Insert(_) => (a + 1, d),
                diffy::Line::Delete(_) => (a, d + 1),
                diffy::Line::Context(_) => (a, d),
            }),
        Err(_) => (0, 0),
    }
}

#[derive(Default)]
struct Draft {
    lines: Vec<String>,
    old_path: String,
    new_path: String,
    rename_to: String,
    renamed: bool,
    added_file: bool,
    deleted_file: bool,
    added: u32,
    removed: u32,
}

fn draft_from_git_header(line: &str) -> Draft {
    let mut draft = Draft::default();
    draft.lines.push(line.to_string());
    if let Some((old_path, new_path)) = git_paths(line) {
        draft.old_path = old_path;
        draft.new_path = new_path;
    }
    draft
}

fn flush_draft(current: &mut Option<Draft>, files: &mut Vec<FileChange>) {
    let Some(draft) = current.take() else {
        return;
    };
    if let Some(file) = finish_draft(draft) {
        files.push(file);
    }
}

fn finish_draft(draft: Draft) -> Option<FileChange> {
    let next = strip_marker(&draft.new_path);
    let prev = strip_marker(&draft.old_path);
    let renamed = draft.renamed
        || (!prev.is_empty()
            && !next.is_empty()
            && prev != next
            && prev != "/dev/null"
            && next != "/dev/null");
    let mut status = FileStatus::Modified;
    let mut path = if !next.is_empty() && next != "/dev/null" {
        next.clone()
    } else {
        prev.clone()
    };
    if draft.deleted_file || next == "/dev/null" {
        status = FileStatus::Deleted;
        if !prev.is_empty() && prev != "/dev/null" {
            path = prev;
        }
    } else if draft.added_file || prev == "/dev/null" || (prev.is_empty() && !next.is_empty()) {
        status = FileStatus::Added;
        if !next.is_empty() && next != "/dev/null" {
            path = next;
        }
    } else if renamed {
        status = FileStatus::Renamed;
        path = if draft.rename_to.is_empty() {
            next
        } else {
            display_path(&draft.rename_to)
        };
    }
    if path.is_empty() || path == "/dev/null" {
        return None;
    }
    Some(FileChange {
        path: display_path(&path),
        status,
        added: draft.added,
        removed: draft.removed,
        diff: draft.lines.join("\n"),
    })
}

fn git_paths(line: &str) -> Option<(String, String)> {
    let rest = line.trim_start_matches("diff --git ").trim();
    if let Some(rest) = rest.strip_prefix('"') {
        let (old_path, rest) = rest.split_once('"')?;
        let rest = rest.trim().strip_prefix('"')?;
        let new_path = rest.strip_suffix('"')?;
        return Some((old_path.to_string(), new_path.to_string()));
    }
    if let Some(split) = rest.find(" b/") {
        if rest.starts_with("a/") {
            return Some((rest[..split].to_string(), rest[split + 1..].to_string()));
        }
    }
    None
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .unwrap_or(value)
        .to_string()
}

fn strip_marker(path: &str) -> String {
    let bare = unquote(path);
    if bare == "/dev/null" {
        return bare;
    }
    bare.strip_prefix("a/")
        .or_else(|| bare.strip_prefix("b/"))
        .unwrap_or(&bare)
        .to_string()
}

fn display_path(path: &str) -> String {
    strip_marker(path.trim())
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_change_kinds_become_status_letters_and_line_counts() {
        let files = file_changes_from_codex(&json!([
            {
                "path": "src/new.ts",
                "kind": "add",
                "diff": "one\ntwo\n"
            },
            {
                "path": "src/old.ts",
                "kind": "delete",
                "diff": "gone\n"
            },
            {
                "path": "src/app.ts",
                "kind": "update",
                "diff": "@@ -1 +1 @@\n-a\n+b\n"
            },
            {
                "path": "src/next.ts",
                "kind": "rename",
                "diff": "rename from src/prev.ts\nrename to src/next.ts\n"
            }
        ]));
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].status, FileStatus::Added);
        assert_eq!(files[0].added, 2);
        assert_eq!(files[0].removed, 0);
        assert_eq!(files[1].status, FileStatus::Deleted);
        assert_eq!(files[1].removed, 1);
        assert_eq!(files[2].status, FileStatus::Modified);
        assert_eq!((files[2].added, files[2].removed), (1, 1));
        assert_eq!(files[3].status, FileStatus::Renamed);
        assert_eq!(files[3].path, "src/next.ts");
    }

    #[test]
    fn single_letter_kinds_and_unified_diff_headers_normalize() {
        assert_eq!(file_status("A"), FileStatus::Added);
        assert_eq!(file_status("M"), FileStatus::Modified);
        assert_eq!(file_status("D"), FileStatus::Deleted);
        assert_eq!(file_status("R"), FileStatus::Renamed);
        assert_eq!(file_status("moved"), FileStatus::Renamed);

        let diff = "\
diff --git a/note.txt b/note.txt
--- a/note.txt
+++ b/note.txt
@@ -1 +1 @@
-one
+two
diff --git a/fresh.txt b/fresh.txt
new file mode 100644
--- /dev/null
+++ b/fresh.txt
@@ -0,0 +1 @@
+hi
diff --git a/old-name.txt b/new-name.txt
similarity index 100%
rename from old-name.txt
rename to new-name.txt
";
        let files = parse_unified_files(diff);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "note.txt");
        assert_eq!(files[0].status, FileStatus::Modified);
        assert_eq!((files[0].added, files[0].removed), (1, 1));
        assert_eq!(files[1].path, "fresh.txt");
        assert_eq!(files[1].status, FileStatus::Added);
        assert_eq!(files[2].path, "new-name.txt");
        assert_eq!(files[2].status, FileStatus::Renamed);
    }

    #[test]
    fn normalized_events_keep_turn_id_and_do_not_use_apply_patch() {
        let files = file_changes_from_codex(&json!([{
            "path": "gap-history.txt",
            "kind": "update",
            "diff": "@@ -0,0 +1 @@\n+gap-history-marker"
        }]));
        let mut bodies = Vec::new();
        push_file_change_events(&mut bodies, "turn-9", &files);
        assert!(matches!(
            &bodies[0],
            SessionEventBody::FileChange { turn_id, path, status, added, removed, diff }
                if turn_id == "turn-9"
                    && path == "gap-history.txt"
                    && *status == FileStatus::Modified
                    && *added == 1
                    && *removed == 0
                    && diff.contains("gap-history-marker")
        ));
        assert!(matches!(
            &bodies[1],
            SessionEventBody::TurnChanges { turn_id, files }
                if turn_id == "turn-9" && files.len() == 1 && files[0].path == "gap-history.txt"
        ));
        assert!(!bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::ToolCall { name, .. } if name == "apply_patch"
        )));
    }

    #[test]
    fn line_counts_follow_diff_render() {
        assert_eq!(line_counts("add", "a\nb\nc\n"), (3, 0));
        assert_eq!(line_counts("delete", "a\nb\n"), (0, 2));
        assert_eq!(line_counts("update", "@@ -1,2 +1,2 @@\n keep\n-a\n+b\n"), (1, 1));
        assert_eq!(
            line_counts("update", "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"),
            (1, 1)
        );
        // 行数和 hunk 头对不上时 diffy 解析失败，官方显示 0/0。
        assert_eq!(line_counts("update", "@@ -1,3 +1,4 @@\n-a\n+b\n"), (0, 0));
        assert_eq!(line_counts("A", "one\ntwo\n"), (2, 0));
        assert_eq!(line_counts("create", "one\n"), (1, 0));
        assert_eq!(line_counts("remove", "gone\n"), (0, 1));
    }

    #[test]
    fn nested_add_content_is_the_file_body() {
        let files = file_changes_from_codex(&json!([{
            "path": "src/new.ts",
            "kind": { "type": "add", "content": "alpha\nbeta\n" }
        }]));
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, FileStatus::Added);
        assert_eq!(files[0].diff, "alpha\nbeta\n");
        assert_eq!((files[0].added, files[0].removed), (2, 0));

        let removed = file_changes_from_codex(&json!([{
            "path": "src/old.ts",
            "kind": { "type": "remove" },
            "content": "gone\n"
        }]));
        assert_eq!(removed[0].status, FileStatus::Deleted);
        assert_eq!(removed[0].diff, "gone\n");
        assert_eq!((removed[0].added, removed[0].removed), (0, 1));
    }

    #[test]
    fn codex_object_kind_and_patch_body_count_lines() {
        let hunk = "@@ -1,2 +1,3 @@\n line\n-old\n+new-a\n+new-b\n";
        let files = file_changes_from_codex(&json!([{
            "path": "notes.md",
            "kind": { "type": "update", "move_path": null },
            "diff": hunk
        }]));
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, FileStatus::Modified);
        assert_eq!((files[0].added, files[0].removed), (2, 1));

        let renamed = file_changes_from_codex(&json!([{
            "path": "src/prev.ts",
            "kind": { "type": "update", "move_path": "src/next.ts" },
            "diff": "@@ -1 +1 @@\n-a\n+b\n"
        }]));
        assert_eq!(renamed[0].status, FileStatus::Renamed);
        assert_eq!(renamed[0].path, "src/next.ts");
        assert_eq!((renamed[0].added, renamed[0].removed), (1, 1));
    }

    #[test]
    fn empty_followup_keeps_counts_and_turn_diff_fills_a_blank_patch() {
        let first = file_changes_from_codex(&json!([{
            "path": "C:\\proj\\notes.md",
            "kind": { "type": "update", "move_path": null },
            "diff": "@@ -1 +1,2 @@\n-old\n+new-a\n+new-b\n"
        }]));
        let blank = file_changes_from_codex(&json!([{
            "path": "C:\\proj\\notes.md",
            "kind": { "type": "update", "move_path": null },
            "diff": ""
        }]));
        let merged = merge_file_list(&first, &blank);
        assert_eq!(merged.len(), 1);
        assert_eq!((merged[0].added, merged[0].removed), (2, 1));
        assert!(merged[0].diff.contains("+new-a"));

        let later = file_changes_from_codex(&json!([{
            "path": "C:\\proj\\notes.md",
            "kind": { "type": "update", "move_path": null },
            "diff": "@@ -1 +1 @@\n-old\n+only\n"
        }]));
        let replaced = merge_file_list(&merged, &later);
        assert_eq!((replaced[0].added, replaced[0].removed), (1, 1));

        let empty = file_changes_from_codex(&json!([{
            "path": "C:/proj/notes.md",
            "kind": { "type": "update", "move_path": null },
            "diff": "",
            "unified_diff": ""
        }]));
        assert_eq!((empty[0].added, empty[0].removed), (0, 0));
        let filled = overlay_unified_diff(
            &empty,
            "\
diff --git a/notes.md b/notes.md
--- a/notes.md
+++ b/notes.md
@@ -1 +1,3 @@
-old
+new-a
+new-b
",
        );
        assert_eq!((filled[0].added, filled[0].removed), (2, 1));
        assert!(filled[0].diff.contains("+new-b"));
        assert_eq!(filled[0].path, "C:/proj/notes.md");

        let rollout = file_changes_from_codex(&json!({
            "notes.md": {
                "type": "update",
                "unified_diff": "@@ -1 +1,2 @@\n-old\n+new-a\n+new-b\n",
                "move_path": null
            }
        }));
        assert_eq!(rollout[0].path, "notes.md");
        assert_eq!((rollout[0].added, rollout[0].removed), (2, 1));
    }
}
