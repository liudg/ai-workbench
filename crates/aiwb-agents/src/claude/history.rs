//! `~/.claude/projects` 里的会话 jsonl。
//!
//! 目录名、标题和正文链对齐 Python SDK `sessions.py`：
//! `_sanitize_path` / `_simple_hash`（L81–114）、`list_sessions` 的 lite 读取（L353–511）、
//! `_build_conversation_chain`（L931–1020）、`_is_visible_message`（L1023）、
//! `get_session_messages`（L1059）。项目目录是 `CLAUDE_CONFIG_DIR` 或 `~/.claude` 下的 `projects`
//! （`_get_projects_dir` L130–141）。跳过 sidechain。标题优先 `customTitle`，然后 `aiTitle`、
//! `lastPrompt` / `summary` / 首条用户提示（L441–457）。
//! 侧边栏的 `updated_at` 用最后一条用户或助手消息的 `timestamp`，不用文件 mtime。
//! resume 会重写 jsonl，mtime 会变成刚刚，但消息时间不变。

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

/// 会话的子 Agent 转录目录：`<会话 id>.jsonl` 旁边的 `<会话 id>/subagents`。
pub fn subagent_dir(session_file: &Path) -> PathBuf {
    session_file.with_extension("").join("subagents")
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
    activity_ms: Option<i64>,
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
    let activity_ms = last_conversation_millis(&mut file, size);
    Some(LiteFile {
        mtime_ms,
        activity_ms,
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
        // 最后一条真实对话的时间。resume 改写文件只动 mtime，不该把会话顶上去。
        updated_at: lite.activity_ms.unwrap_or(lite.mtime_ms),
    })
}

const ACTIVITY_CHUNK: u64 = 65_536;
const ACTIVITY_SCAN_MAX: u64 = 16 * 1024 * 1024;
const ACTIVITY_PROBE_MAX: usize = 4_096;
const TYPE_NEEDLES: &[&[u8]] = &[
    b"\"type\":\"assistant\"",
    b"\"type\": \"assistant\"",
    b"\"type\":\"user\"",
    b"\"type\": \"user\"",
];

enum Probe {
    Activity(i64),
    SkipBefore(u64),
    Stop,
}

/// 从文件末尾往前找最后一条用户或助手消息的 `timestamp`。
/// 旁路、元数据、压缩摘要，以及 resume 写入的 hook / tick 不算。
fn last_conversation_millis(file: &mut File, len: u64) -> Option<i64> {
    let mut end = len;
    let mut probes = 0usize;
    while end > 0 && len.saturating_sub(end) <= ACTIVITY_SCAN_MAX && probes < ACTIVITY_PROBE_MAX {
        let take = ACTIVITY_CHUNK.min(end);
        let start = end - take;
        if len.saturating_sub(start) > ACTIVITY_SCAN_MAX && start > 0 {
            break;
        }
        // 多读一点，避免 `"type":"user"` 正好跨过这块的边界。
        let extra = 32.min(len.saturating_sub(end)) as usize;
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut buf = vec![0u8; take as usize + extra];
        file.read_exact(&mut buf).ok()?;
        let Some(rel) = rfind_type(&buf) else {
            end = start;
            continue;
        };
        let abs = start + rel as u64;
        if abs >= end {
            end = start;
            continue;
        }
        probes += 1;
        match probe_at(file, abs, len) {
            Probe::Activity(ms) => return Some(ms),
            Probe::Stop => return None,
            Probe::SkipBefore(next) => {
                if next >= end {
                    if abs == 0 {
                        return None;
                    }
                    end = abs;
                } else {
                    end = next;
                }
            }
        }
    }
    None
}

fn rfind_type(buf: &[u8]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for needle in TYPE_NEEDLES {
        let mut from = 0;
        while from < buf.len() {
            let Some(rel) = find_from(buf, needle, from) else {
                break;
            };
            best = Some(best.map_or(rel, |current| current.max(rel)));
            from = rel + 1;
        }
    }
    best
}

fn find_from(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from >= haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|rel| from + rel)
}

fn probe_at(file: &mut File, abs: u64, len: u64) -> Probe {
    const BACK: u64 = 4_096;
    const FORWARD: u64 = 4_096;
    let begin = abs.saturating_sub(BACK);
    let want = (abs - begin) + FORWARD;
    let read_len = want.min(len.saturating_sub(begin)) as usize;
    if read_len == 0 {
        return Probe::Stop;
    }
    if file.seek(SeekFrom::Start(begin)).is_err() {
        return Probe::SkipBefore(abs);
    }
    let mut buf = vec![0u8; read_len];
    let Ok(read) = file.read(&mut buf) else {
        return Probe::SkipBefore(abs);
    };
    buf.truncate(read);
    let rel = (abs - begin) as usize;
    if rel > buf.len() {
        return Probe::SkipBefore(abs);
    }
    let start_rel = match buf[..rel].iter().rposition(|byte| *byte == b'\n') {
        Some(index) => Some(index + 1),
        None if begin == 0 => Some(0),
        None => None,
    };
    let Some(start_rel) = start_rel else {
        return probe_line_start(file, abs, len);
    };
    let end_rel = buf[rel..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|index| rel + index)
        .unwrap_or(buf.len());
    let prefix = String::from_utf8_lossy(&buf[start_rel..end_rel]);
    let line_start = begin + start_rel as u64;
    match conversation_millis_of_line(&prefix) {
        Some(ms) => Probe::Activity(ms),
        None => Probe::SkipBefore(line_start),
    }
}

/// 命中落在超长行中间时，回到这一行开头看信封上的 type / timestamp。
fn probe_line_start(file: &mut File, abs: u64, len: u64) -> Probe {
    let Some(line_start) = line_start_before(file, abs) else {
        return if abs == 0 {
            Probe::Stop
        } else {
            Probe::SkipBefore(abs)
        };
    };
    if line_start >= abs {
        return Probe::SkipBefore(abs);
    }
    if file.seek(SeekFrom::Start(line_start)).is_err() {
        return Probe::SkipBefore(line_start);
    }
    let want = 4_096.min(len.saturating_sub(line_start)) as usize;
    let mut buf = vec![0u8; want];
    let Ok(read) = file.read(&mut buf) else {
        return Probe::SkipBefore(line_start);
    };
    buf.truncate(read);
    let end = buf
        .iter()
        .position(|byte| *byte == b'\n')
        .unwrap_or(buf.len());
    let prefix = String::from_utf8_lossy(&buf[..end]);
    match conversation_millis_of_line(&prefix) {
        Some(ms) => Probe::Activity(ms),
        None => Probe::SkipBefore(line_start),
    }
}

fn line_start_before(file: &mut File, from: u64) -> Option<u64> {
    let mut end = from;
    let mut walked = 0u64;
    while end > 0 && walked < ACTIVITY_SCAN_MAX {
        let take = ACTIVITY_CHUNK.min(end);
        let start = end - take;
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut buf = vec![0u8; take as usize];
        file.read_exact(&mut buf).ok()?;
        if let Some(rel) = buf.iter().rposition(|byte| *byte == b'\n') {
            return Some(start + rel as u64 + 1);
        }
        walked += take;
        end = start;
    }
    if end == 0 {
        Some(0)
    } else {
        None
    }
}

fn conversation_millis_of_line(line: &str) -> Option<i64> {
    let line = line.trim().trim_end_matches('\r');
    if line.is_empty() {
        return None;
    }
    if line.len() <= LITE_READ_BUF_SIZE {
        if let Ok(entry) = serde_json::from_str::<Value>(line) {
            return conversation_millis_of_entry(&entry);
        }
    }
    conversation_millis_of_prefix(line)
}

fn conversation_millis_of_entry(entry: &Value) -> Option<i64> {
    let kind = entry.get("type").and_then(Value::as_str)?;
    if kind != "user" && kind != "assistant" {
        return None;
    }
    if flag(entry, "isSidechain") || flag(entry, "isMeta") || flag(entry, "isCompactSummary") {
        return None;
    }
    if kind == "user" && resume_noise_entry(entry) {
        return None;
    }
    parse_millis(entry.get("timestamp").and_then(Value::as_str)?)
}

fn resume_noise_entry(entry: &Value) -> bool {
    let message = entry.get("message").unwrap_or(&Value::Null);
    let content = message.get("content").unwrap_or(&Value::Null);
    let text = content_text(content);
    resume_noise_text(text.trim_start())
}

fn conversation_millis_of_prefix(prefix: &str) -> Option<i64> {
    let header = prefix.split("\"message\"").next().unwrap_or(prefix);
    let kind = first_string(header, "type")?;
    if kind != "user" && kind != "assistant" {
        return None;
    }
    if prefix_flag(header, "isSidechain")
        || prefix_flag(header, "isMeta")
        || prefix_flag(header, "isCompactSummary")
    {
        return None;
    }
    if kind == "user" && resume_noise_prefix(prefix) {
        return None;
    }
    let stamp = first_string(header, "timestamp").or_else(|| first_string(prefix, "timestamp"))?;
    parse_millis(&stamp)
}

fn prefix_flag(header: &str, key: &str) -> bool {
    header.contains(&format!("\"{key}\":true")) || header.contains(&format!("\"{key}\": true"))
}

fn resume_noise_prefix(prefix: &str) -> bool {
    const MARKERS: &[&str] = &["<session-start-hook>", "<tick>", "<local-command-stdout>"];
    MARKERS
        .iter()
        .any(|marker| prefix.contains(&format!("\"{marker}")))
}

fn resume_noise_text(text: &str) -> bool {
    text.starts_with("<local-command-stdout>")
        || text.starts_with("<session-start-hook>")
        || text.starts_with("<tick>")
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

pub(super) fn parse_millis(stamp: &str) -> Option<i64> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{Duration, SystemTime};

    const OLDER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const NEWER: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    fn scratch(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("claude-history-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_session(root: &Path, id: &str, body: &str) -> PathBuf {
        let project = root.join("-workspace-demo");
        std::fs::create_dir_all(&project).unwrap();
        let path = project.join(format!("{id}.jsonl"));
        std::fs::write(&path, body).unwrap();
        path
    }

    fn touch(path: &Path, secs: u64) {
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(secs))
            .unwrap();
    }

    fn user_line(uuid: &str, stamp: &str, text: &str) -> String {
        format!(
            "{}\n",
            serde_json::json!({
                "type": "user",
                "uuid": uuid,
                "parentUuid": null,
                "cwd": "/workspace/demo",
                "timestamp": stamp,
                "message": {"role": "user", "content": text}
            })
        )
    }

    fn listed_at(root: &Path, id: &str) -> i64 {
        list_sessions_under(root)
            .into_iter()
            .find(|item| item.session_id == id)
            .unwrap()
            .updated_at
    }

    #[test]
    fn sidebar_time_follows_the_last_message_not_the_file_mtime() {
        let root = scratch("mtime");
        let early = "2020-01-01T00:00:00Z";
        let later = "2021-06-01T00:00:00Z";
        let mut body = user_line("11111111-1111-4111-8111-111111111111", early, "先说的");
        body.push_str(&format!(
            "{}\n",
            serde_json::json!({
                "type": "assistant",
                "uuid": "22222222-2222-4222-8222-222222222222",
                "parentUuid": "11111111-1111-4111-8111-111111111111",
                "timestamp": later,
                "message": {"role": "assistant", "content": [{"type": "text", "text": "后说的"}]}
            })
        ));
        let path = write_session(&root, OLDER, &body);
        touch(&path, 1_700_000_000);
        let expected = parse_millis(later).unwrap();
        assert_eq!(listed_at(&root, OLDER), expected);
        assert!(listed_at(&root, OLDER) < 1_700_000_000_000);

        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(
                format!(
                    "{}\n",
                    serde_json::json!({
                        "type": "custom-title",
                        "customTitle": "改名",
                        "sessionId": OLDER
                    })
                )
                .as_bytes(),
            )
            .unwrap();
        touch(&path, 1_800_000_000);
        assert_eq!(listed_at(&root, OLDER), expected);
        assert_eq!(
            list_sessions_under(&root)
                .into_iter()
                .find(|item| item.session_id == OLDER)
                .unwrap()
                .title,
            "改名"
        );

        let hook = format!(
            "{}\n",
            serde_json::json!({
                "type": "user",
                "uuid": "33333333-3333-4333-8333-333333333333",
                "parentUuid": "22222222-2222-4222-8222-222222222222",
                "timestamp": "2026-10-19T00:00:00Z",
                "isMeta": false,
                "message": {"role": "user", "content": "<session-start-hook>boot"}
            })
        );
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(hook.as_bytes())
            .unwrap();
        touch(&path, 1_900_000_000);
        assert_eq!(listed_at(&root, OLDER), expected);

        let side = format!(
            "{}\n",
            serde_json::json!({
                "type": "user",
                "uuid": "44444444-4444-4444-8444-444444444444",
                "parentUuid": null,
                "isSidechain": true,
                "timestamp": "2026-10-19T01:00:00Z",
                "message": {"role": "user", "content": "side"}
            })
        );
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(side.as_bytes())
            .unwrap();
        assert_eq!(listed_at(&root, OLDER), expected);

        let follow = user_line(
            "55555555-5555-4555-8555-555555555555",
            "2022-01-01T00:00:00Z",
            "又一句",
        );
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(follow.as_bytes())
            .unwrap();
        touch(&path, 1_600_000_000);
        assert_eq!(
            listed_at(&root, OLDER),
            parse_millis("2022-01-01T00:00:00Z").unwrap()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_newer_mtime_does_not_sort_ahead_of_a_later_message() {
        let root = scratch("order");
        let older_body = user_line(
            "11111111-1111-4111-8111-111111111111",
            "2020-01-01T00:00:00Z",
            "旧对话",
        );
        let newer_body = user_line(
            "22222222-2222-4222-8222-222222222222",
            "2024-05-01T00:00:00Z",
            "新对话",
        );
        let older_path = write_session(&root, OLDER, &older_body);
        let newer_path = write_session(&root, NEWER, &newer_body);
        touch(&older_path, 1_900_000_000);
        touch(&newer_path, 1_600_000_000);
        let listed = list_sessions_under(&root);
        assert_eq!(listed[0].session_id, NEWER);
        assert_eq!(listed[1].session_id, OLDER);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_long_trailing_snapshot_does_not_hide_the_message_time() {
        let root = scratch("blob");
        let stamp = "2019-08-08T08:08:08Z";
        let mut body = user_line("11111111-1111-4111-8111-111111111111", stamp, "还在");
        let mut blob = String::from("{\"type\":\"file-history-snapshot\",\"entries\":[");
        blob.push_str(&"{\"type\":\"user\",\"timestamp\":\"2026-01-01T00:00:00Z\"},".repeat(2_000));
        blob.push_str("]}\n");
        body.push_str(&blob);
        let path = write_session(&root, OLDER, &body);
        touch(&path, 1_800_000_000);
        assert_eq!(listed_at(&root, OLDER), parse_millis(stamp).unwrap());

        let mut long = format!(
            "{{\"type\":\"user\",\"uuid\":\"66666666-6666-4666-8666-666666666666\",\"cwd\":\"/workspace/demo\",\"timestamp\":\"{stamp}\",\"message\":{{\"role\":\"user\",\"content\":\"{}\"}}}}\n",
            "b".repeat(80_000)
        );
        // 上面这条覆盖同一文件，时间仍应来自开头的 timestamp，而不是 mtime。
        long.insert_str(
            0,
            &user_line(
                "11111111-1111-4111-8111-111111111111",
                "2018-01-01T00:00:00Z",
                "更早",
            ),
        );
        std::fs::write(&path, long).unwrap();
        touch(&path, 1_800_000_000);
        assert_eq!(listed_at(&root, OLDER), parse_millis(stamp).unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_transcript_without_timestamps_still_uses_mtime() {
        let root = scratch("fallback");
        let body = format!(
            "{}\n",
            serde_json::json!({
                "type": "user",
                "uuid": "11111111-1111-4111-8111-111111111111",
                "cwd": "/workspace/demo",
                "message": {"role": "user", "content": "没有时间"}
            })
        );
        let path = write_session(&root, OLDER, &body);
        touch(&path, 123_456);
        assert_eq!(listed_at(&root, OLDER), 123_456_000);
        let _ = std::fs::remove_dir_all(&root);
    }
}
