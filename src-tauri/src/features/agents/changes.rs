//! 把各适配器的补丁归一成 `file-change` / `turn-changes`。
//! 实时通知和历史回放都走这里，不再为了旧前端把事件改名成 `apply_patch`。

use serde_json::Value;

use crate::models::{FileChange, FileStatus, SessionEventBody};

pub fn file_changes_from_codex(changes: &Value) -> Vec<FileChange> {
    let Some(list) = changes.as_array() else {
        return Vec::new();
    };
    list.iter().filter_map(file_change_from_value).collect()
}

pub fn file_change_from_value(change: &Value) -> Option<FileChange> {
    let path = change
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())?;
    let kind = change
        .get("kind")
        .or_else(|| change.get("type"))
        .or_else(|| change.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let diff = change
        .get("diff")
        .or_else(|| change.get("unifiedDiff"))
        .or_else(|| change.get("patch"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let (added, removed) = diff_counts(&diff);
    Some(FileChange {
        path: display_path(path),
        status: file_status(kind),
        added,
        removed,
        diff,
    })
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

pub fn push_file_change_events(bodies: &mut Vec<SessionEventBody>, turn_id: &str, files: &[FileChange]) {
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

fn diff_counts(diff: &str) -> (u32, u32) {
    let mut added = 0;
    let mut removed = 0;
    for line in diff.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.starts_with('+') && !line.starts_with("+++") {
            added += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            removed += 1;
        }
    }
    (added, removed)
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
                "diff": "@@ -0,0 +1,2 @@\n+one\n+two"
            },
            {
                "path": "src/old.ts",
                "kind": "delete",
                "diff": "@@ -1 +0,0 @@\n-gone"
            },
            {
                "path": "src/app.ts",
                "kind": "update",
                "diff": "@@ -1,2 +1,2 @@\n-a\n+b"
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
}
