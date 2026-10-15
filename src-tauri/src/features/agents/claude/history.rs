//! `~/.claude/projects` 里的会话 jsonl。
//!
//! 目录名、标题和正文链对齐 Python SDK `sessions.py`：
//! `_sanitize_path` / `_simple_hash`（L81–114）、`list_sessions` 的 lite 读取（L353–511）、
//! `_build_conversation_chain`（L931–1020）、`_is_visible_message`（L1023）、
//! `get_session_messages`（L1059）。项目目录是 `CLAUDE_CONFIG_DIR` 或 `~/.claude` 下的 `projects`
//! （`_get_projects_dir` L130–141）。跳过 sidechain。标题优先 `customTitle`，然后 `aiTitle`、
//! `lastPrompt` / `summary` / 首条用户提示（L441–457）。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::Value;

pub const LITE_READ_BUF_SIZE: usize = 65536;
pub const MAX_SANITIZED_LENGTH: usize = 200;
pub const PAGE_SIZE: usize = 40;

#[derive(Debug, Clone)]
pub struct ListedSession {
    pub session_id: String,
    pub title: String,
    pub cwd: String,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn projects_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        let dir = PathBuf::from(dir);
        if !dir.as_os_str().is_empty() {
            return dir.join("projects");
        }
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    match home {
        Some(home) => PathBuf::from(home).join(".claude").join("projects"),
        None => PathBuf::from(".claude").join("projects"),
    }
}

pub fn list_sessions() -> Vec<ListedSession> {
    list_sessions_under(&projects_dir())
}

pub fn list_sessions_under(projects: &Path) -> Vec<ListedSession> {
    let mut listed = Vec::new();
    let entries = match std::fs::read_dir(projects) {
        Ok(entries) => entries,
        Err(_) => return listed,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        listed.extend(list_project_dir(&path));
    }
    listed.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    listed
}

pub fn list_project_dir(project_dir: &Path) -> Vec<ListedSession> {
    let mut listed = Vec::new();
    let entries = match std::fs::read_dir(project_dir) {
        Ok(entries) => entries,
        Err(_) => return listed,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(session_id) = name.strip_suffix(".jsonl") else {
            continue;
        };
        if !is_uuid(session_id) {
            continue;
        }
        let Some(lite) = read_lite(&path) else {
            continue;
        };
        if let Some(info) = parse_lite(session_id, &lite) {
            listed.push(info);
        }
    }
    listed
}

pub fn find_session_file(session_id: &str) -> Option<PathBuf> {
    if !is_uuid(session_id) {
        return None;
    }
    find_session_file_under(&projects_dir(), session_id)
}

pub fn find_session_file_under(projects: &Path, session_id: &str) -> Option<PathBuf> {
    let name = format!("{session_id}.jsonl");
    let entries = std::fs::read_dir(projects).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let candidate = path.join(&name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub fn remove_session_file(session_id: &str) -> Result<(), String> {
    let Some(path) = find_session_file(session_id) else {
        return Ok(());
    };
    std::fs::remove_file(path).map_err(|err| err.to_string())
}

/// 把一条会话复制成新的 uuid。只改 `sessionId` / `session_id` 字段，不改正文里碰巧出现的同一串字符。
///
/// 2026-10-15，Claude Code 2.1.300：`claude --print --resume <id> --fork-session` 不带提示词退出码 1，
/// stderr 为 `No deferred tool marker found in the resumed session. ... Provide a prompt to continue the conversation.`
/// 带提示词会新开一轮用户没写的对话。`--fork-session` 的产物就是一份新 session id 的转录。
pub fn fork_session_file(session_id: &str) -> Result<ListedSession, String> {
    if !is_uuid(session_id) {
        return Err(format!("无效的会话 id：{session_id}"));
    }
    let path = find_session_file(session_id).ok_or_else(|| format!("找不到会话 {session_id}"))?;
    fork_under(&path, session_id)
}

pub fn fork_under(source: &Path, session_id: &str) -> Result<ListedSession, String> {
    if !is_uuid(session_id) {
        return Err(format!("无效的会话 id：{session_id}"));
    }
    let text = std::fs::read_to_string(source).map_err(|err| err.to_string())?;
    let new_id = uuid::Uuid::new_v4().to_string();
    let rewritten = rewrite_session_ids(&text, session_id, &new_id);
    let parent = source
        .parent()
        .ok_or_else(|| "会话文件没有目录".to_string())?;
    let dest = parent.join(format!("{new_id}.jsonl"));
    std::fs::write(&dest, &rewritten).map_err(|err| err.to_string())?;
    let lite = read_lite(&dest).ok_or_else(|| "分叉后的会话读不出来".to_string())?;
    parse_lite(&new_id, &lite).ok_or_else(|| "分叉后的会话没有标题".to_string())
}

fn rewrite_session_ids(text: &str, old_id: &str, new_id: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        out.push_str(&rewrite_session_ids_line(line, old_id, new_id));
    }
    out
}

fn rewrite_session_ids_line(line: &str, old_id: &str, new_id: &str) -> String {
    let mut out = line.to_string();
    let mut from = 0;
    while from < out.len() {
        let Some((key_rel, key_len)) = next_session_key(&out[from..]) else {
            break;
        };
        let after_key = from + key_rel + key_len;
        let tail = &out[after_key..];
        let Some(colon_rel) = tail.find(':') else {
            break;
        };
        if !tail[..colon_rel].chars().all(char::is_whitespace) {
            from = after_key;
            continue;
        }
        let after_colon = after_key + colon_rel + 1;
        let value_tail = &out[after_colon..];
        let Some(quote_rel) = value_tail.find('"') else {
            break;
        };
        if !value_tail[..quote_rel].chars().all(char::is_whitespace) {
            from = after_colon;
            continue;
        }
        let value_start = after_colon + quote_rel + 1;
        let value = &out[value_start..];
        if value.starts_with(old_id) && value.as_bytes().get(old_id.len()) == Some(&b'"') {
            out.replace_range(value_start..value_start + old_id.len(), new_id);
            from = value_start + new_id.len();
        } else {
            from = value_start;
        }
    }
    out
}

fn next_session_key(text: &str) -> Option<(usize, usize)> {
    let session_id = text.find("\"sessionId\"");
    let session_id_snake = text.find("\"session_id\"");
    match (session_id, session_id_snake) {
        (Some(left), Some(right)) if left <= right => Some((left, "\"sessionId\"".len())),
        (Some(_), Some(right)) => Some((right, "\"session_id\"".len())),
        (Some(left), None) => Some((left, "\"sessionId\"".len())),
        (None, Some(right)) => Some((right, "\"session_id\"".len())),
        (None, None) => None,
    }
}

pub fn read_session_text(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).to_string())
}

pub fn transcript_entries(content: &str) -> Vec<Value> {
    let mut entries = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if entry.get("uuid").and_then(Value::as_str).is_none() {
            continue;
        }
        entries.push(entry);
    }
    entries
}

/// `sessions.py` `_build_conversation_chain`。不跟随 `logicalParentUuid`。
pub fn conversation_chain(entries: &[Value]) -> Vec<Value> {
    if entries.is_empty() {
        return Vec::new();
    }
    let mut by_uuid: std::collections::HashMap<&str, &Value> = std::collections::HashMap::new();
    let mut index: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for (position, entry) in entries.iter().enumerate() {
        let Some(uuid) = entry.get("uuid").and_then(Value::as_str) else {
            continue;
        };
        by_uuid.insert(uuid, entry);
        index.insert(uuid, position);
    }
    let mut parents = std::collections::HashSet::new();
    for entry in entries {
        if let Some(parent) = entry.get("parentUuid").and_then(Value::as_str) {
            if !parent.is_empty() {
                parents.insert(parent);
            }
        }
    }
    let terminals: Vec<&Value> = entries
        .iter()
        .filter(|entry| {
            entry
                .get("uuid")
                .and_then(Value::as_str)
                .map(|uuid| !parents.contains(uuid))
                .unwrap_or(false)
        })
        .collect();
    let mut leaves = Vec::new();
    for terminal in terminals {
        let mut current = Some(terminal);
        let mut seen = std::collections::HashSet::new();
        while let Some(entry) = current {
            let Some(uuid) = entry.get("uuid").and_then(Value::as_str) else {
                break;
            };
            if !seen.insert(uuid) {
                break;
            }
            let kind = entry.get("type").and_then(Value::as_str).unwrap_or("");
            if kind == "user" || kind == "assistant" {
                leaves.push(entry);
                break;
            }
            current = entry
                .get("parentUuid")
                .and_then(Value::as_str)
                .and_then(|parent| by_uuid.get(parent).copied());
        }
    }
    if leaves.is_empty() {
        return Vec::new();
    }
    let main: Vec<&Value> = leaves
        .iter()
        .copied()
        .filter(|leaf| {
            !flag(leaf, "isSidechain")
                && !flag(leaf, "isMeta")
                && text_field(leaf, "teamName").is_empty()
        })
        .collect();
    let pool: Vec<&Value> = if main.is_empty() { leaves } else { main };
    let mut best = pool[0];
    let mut best_index = index
        .get(best.get("uuid").and_then(Value::as_str).unwrap_or(""))
        .copied()
        .unwrap_or(0);
    for candidate in pool.iter().skip(1) {
        let position = index
            .get(candidate.get("uuid").and_then(Value::as_str).unwrap_or(""))
            .copied()
            .unwrap_or(0);
        if position > best_index {
            best = candidate;
            best_index = position;
        }
    }
    let mut chain = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut current = Some(best);
    while let Some(entry) = current {
        let Some(uuid) = entry.get("uuid").and_then(Value::as_str) else {
            break;
        };
        if !seen.insert(uuid) {
            break;
        }
        chain.push((*entry).clone());
        current = entry
            .get("parentUuid")
            .and_then(Value::as_str)
            .and_then(|parent| by_uuid.get(parent).copied());
    }
    chain.reverse();
    chain
}

pub fn is_visible_message(entry: &Value) -> bool {
    let kind = entry.get("type").and_then(Value::as_str).unwrap_or("");
    if kind != "user" && kind != "assistant" {
        return false;
    }
    if flag(entry, "isMeta") || flag(entry, "isSidechain") {
        return false;
    }
    text_field(entry, "teamName").is_empty()
}

pub fn sanitize_path(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    if sanitized.len() <= MAX_SANITIZED_LENGTH {
        return sanitized;
    }
    format!(
        "{}-{}",
        &sanitized[..MAX_SANITIZED_LENGTH],
        simple_hash(name)
    )
}

/// JS `hash |= 0` 的 32 位有符号哈希，再 `Math.abs`、`toString(36)`。
/// `sessions.py` `_simple_hash` L81–101。
pub fn simple_hash(value: &str) -> String {
    let mut hash: i32 = 0;
    for ch in value.chars() {
        let code = ch as u32 as i32;
        hash = hash.wrapping_shl(5).wrapping_sub(hash).wrapping_add(code);
    }
    let mut number = hash.unsigned_abs();
    if number == 0 {
        return "0".to_string();
    }
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while number > 0 {
        out.push(DIGITS[(number % 36) as usize]);
        number /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_else(|_| "0".to_string())
}

pub fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let ok = match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        };
        if !ok {
            return false;
        }
    }
    true
}

struct LiteFile {
    mtime_ms: i64,
    head: String,
    tail: String,
}

fn read_lite(path: &Path) -> Option<LiteFile> {
    let mut file = File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    let size = meta.len();
    if size == 0 {
        return None;
    }
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let mut head_buf = vec![0u8; LITE_READ_BUF_SIZE.min(size as usize)];
    file.read_exact(&mut head_buf).ok()?;
    let head = String::from_utf8_lossy(&head_buf).to_string();
    let tail = if size as usize <= LITE_READ_BUF_SIZE {
        head.clone()
    } else {
        let offset = size - LITE_READ_BUF_SIZE as u64;
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut tail_buf = vec![0u8; LITE_READ_BUF_SIZE];
        let read = file.read(&mut tail_buf).ok()?;
        String::from_utf8_lossy(&tail_buf[..read]).to_string()
    };
    Some(LiteFile {
        mtime_ms,
        head,
        tail,
    })
}

fn parse_lite(session_id: &str, lite: &LiteFile) -> Option<ListedSession> {
    let first_line = lite.head.lines().next().unwrap_or("");
    if first_line.contains("\"isSidechain\":true") || first_line.contains("\"isSidechain\": true") {
        return None;
    }
    let custom = last_string(&lite.tail, "customTitle")
        .or_else(|| last_string(&lite.head, "customTitle"))
        .or_else(|| last_string(&lite.tail, "aiTitle"))
        .or_else(|| last_string(&lite.head, "aiTitle"));
    let first_prompt = first_prompt(&lite.head);
    let title = custom
        .clone()
        .or_else(|| last_string(&lite.tail, "lastPrompt"))
        .or_else(|| last_string(&lite.tail, "summary"))
        .or_else(|| {
            if first_prompt.is_empty() {
                None
            } else {
                Some(first_prompt)
            }
        })?;
    let title = title.trim().to_string();
    if title.is_empty() {
        return None;
    }
    let cwd = first_string(&lite.head, "cwd").unwrap_or_default();
    let created_at = first_string(&lite.head, "timestamp")
        .and_then(|stamp| parse_millis(&stamp))
        .unwrap_or(lite.mtime_ms);
    Some(ListedSession {
        session_id: session_id.to_string(),
        title,
        cwd,
        created_at,
        updated_at: lite.mtime_ms,
    })
}

fn first_prompt(head: &str) -> String {
    for line in head.lines() {
        if !line.contains("\"type\":\"user\"") && !line.contains("\"type\": \"user\"") {
            continue;
        }
        if line.contains("\"tool_result\"")
            || line.contains("\"isMeta\":true")
            || line.contains("\"isMeta\": true")
            || line.contains("\"isCompactSummary\":true")
            || line.contains("\"isCompactSummary\": true")
        {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let message = entry.get("message").unwrap_or(&Value::Null);
        let content = message.get("content").unwrap_or(&Value::Null);
        let text = content_text(content);
        let flat = text.replace('\n', " ");
        let flat = flat.trim();
        if flat.is_empty() || flat.contains("<command-name>") {
            continue;
        }
        if flat.starts_with("<local-command-stdout>")
            || flat.starts_with("<session-start-hook>")
            || flat.starts_with("<tick>")
            || flat.starts_with("<goal>")
            || flat.starts_with("[Request interrupted by user")
        {
            continue;
        }
        let mut chars = flat.chars();
        let clipped: String = chars.by_ref().take(200).collect();
        if chars.next().is_some() {
            return format!("{clipped}…");
        }
        return clipped;
    }
    String::new()
}

fn content_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    blocks
        .iter()
        .filter_map(|block| {
            if block.get("type").and_then(Value::as_str) == Some("text") {
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("")
}

fn first_string(text: &str, key: &str) -> Option<String> {
    scan_string(text, key, false)
}

fn last_string(text: &str, key: &str) -> Option<String> {
    scan_string(text, key, true)
}

fn scan_string(text: &str, key: &str, last: bool) -> Option<String> {
    let patterns = [format!("\"{key}\":\""), format!("\"{key}\": \"")];
    let mut found = None;
    for pattern in &patterns {
        let mut from = 0;
        while let Some(rel) = text[from..].find(pattern) {
            let start = from + rel + pattern.len();
            let bytes = text.as_bytes();
            let mut index = start;
            while index < bytes.len() {
                if bytes[index] == b'\\' {
                    index = index.saturating_add(2);
                    continue;
                }
                if bytes[index] == b'"' {
                    let raw = &text[start..index];
                    found = Some(unescape(raw));
                    from = index + 1;
                    break;
                }
                index += 1;
            }
            if index >= bytes.len() {
                break;
            }
            if !last && found.is_some() {
                return found;
            }
        }
    }
    found
}

fn unescape(raw: &str) -> String {
    if !raw.contains('\\') {
        return raw.to_string();
    }
    serde_json::from_str::<String>(&format!("\"{raw}\"")).unwrap_or_else(|_| raw.to_string())
}

fn parse_millis(stamp: &str) -> Option<i64> {
    let normalized = if stamp.ends_with('Z') {
        format!("{}+00:00", &stamp[..stamp.len() - 1])
    } else {
        stamp.to_string()
    };
    let parsed = chrono::DateTime::parse_from_rfc3339(&normalized).ok()?;
    Some(parsed.timestamp_millis())
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn text_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}
