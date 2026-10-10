//! Codex `resume --all` 会话目录。
//!
//! `codex resume --all` 关闭 cwd 过滤，但仍只显示交互会话（不含
//! `--include-non-interactive`，也不含已归档）。这与 app-server
//! `thread/list` 在省略 `sourceKinds`、`archived: false`、不传 `cwd` 时的
//! 结果是同一份列表。`~/.codex/session_index.jsonl` 只有 id / 标题，没有
//! cwd，而且和这份列表对不齐，所以不能当来源。
//!
//! 会话 id 就是 Codex thread id。本模块只负责列出线程；真正恢复用
//! `thread/resume`，历史用 `thread/turns/list`。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

use crate::encoding::{apply_utf8_env, decode_child_bytes};
use crate::models::{
    strip_verbatim_prefix, AgentKind, Project, Session, SessionEventBody, SessionStatus,
};

const CACHE_TTL: Duration = Duration::from_secs(8);
const PAGE_LIMIT: u32 = 100;
const MAX_PAGES: usize = 40;
const HISTORY_PAGE: u32 = 20;
const HISTORY_PAGES: usize = 3;

#[derive(Debug, Clone)]
pub struct CodexThread {
    pub id: String,
    pub cwd: String,
    pub key: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub status: SessionStatus,
    pub ephemeral: bool,
}

pub struct CodexDirectory {
    inner: tokio::sync::Mutex<DirectoryState>,
}

struct DirectoryState {
    client: Option<RpcClient>,
    cache: Option<Cache>,
}

struct Cache {
    at: Instant,
    result: Result<Vec<CodexThread>, String>,
}

impl CodexDirectory {
    pub fn new() -> Self {
        Self {
            inner: tokio::sync::Mutex::new(DirectoryState {
                client: None,
                cache: None,
            }),
        }
    }

    pub async fn invalidate(&self) {
        self.inner.lock().await.cache = None;
    }

    /// 交互、未归档的全部线程。短时间内复用上一次结果，避免每个项目都拉起进程。
    pub async fn list_threads(&self) -> Result<Vec<CodexThread>, String> {
        let mut state = self.inner.lock().await;
        if let Some(cache) = &state.cache {
            if cache.at.elapsed() < CACHE_TTL {
                return cache.result.clone();
            }
        }
        let result = fetch_threads(&mut state.client).await;
        state.cache = Some(Cache {
            at: Instant::now(),
            result: result.clone(),
        });
        result
    }
}

impl Default for CodexDirectory {
    fn default() -> Self {
        Self::new()
    }
}

async fn fetch_threads(client: &mut Option<RpcClient>) -> Result<Vec<CodexThread>, String> {
    let mut last_err = String::from("无法读取 Codex 会话");
    for attempt in 0..2 {
        if client.is_none() {
            *client = Some(RpcClient::spawn().await?);
        }
        match client.as_ref().unwrap().list_pages().await {
            Ok(threads) => return Ok(threads),
            Err(err) => {
                *client = None;
                last_err = err;
                if attempt == 1 {
                    break;
                }
            }
        }
    }
    Err(last_err)
}

/// 已保存的项目在前；resume 里出现、但还没导入的目录按最近更新排在后面。
pub fn group_projects(stored: &[Project], threads: &[CodexThread]) -> Vec<Project> {
    let mut seen = HashSet::new();
    let mut projects = Vec::with_capacity(stored.len());
    for project in stored {
        let mut project = project.clone();
        project.external = false;
        seen.insert(cwd_key(&project.path));
        projects.push(project);
    }

    let mut discovered: HashMap<String, (String, i64, i64)> = HashMap::new();
    for thread in threads {
        if thread.ephemeral || seen.contains(&thread.key) {
            continue;
        }
        let slot = discovered
            .entry(thread.key.clone())
            .or_insert_with(|| (thread.cwd.clone(), thread.created_at, thread.updated_at));
        if thread.created_at > 0 && (slot.1 == 0 || thread.created_at < slot.1) {
            slot.1 = thread.created_at;
        }
        if thread.updated_at > slot.2 {
            slot.2 = thread.updated_at;
        }
    }

    let mut extra: Vec<Project> = discovered
        .into_iter()
        .map(|(key, (cwd, created, updated))| Project {
            id: virtual_project_id(&key),
            name: folder_name(&cwd),
            path: cwd,
            default_agent: AgentKind::CodexCli,
            created_at: created,
            updated_at: updated,
            external: true,
        })
        .collect();
    extra.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.name.cmp(&b.name))
    });
    projects.extend(extra);
    projects
}

pub fn sessions_for_project(project: &Project, threads: &[CodexThread]) -> Vec<Session> {
    let key = cwd_key(&project.path);
    let mut sessions: Vec<Session> = threads
        .iter()
        .filter(|thread| !thread.ephemeral && thread.key == key)
        .map(|thread| Session {
            id: thread.id.clone(),
            project_id: project.id.clone(),
            agent: AgentKind::CodexCli,
            title: thread.title.clone(),
            status: thread.status,
            created_at: thread.created_at,
            updated_at: thread.updated_at,
        })
        .collect();
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

pub fn virtual_project_id(key: &str) -> String {
    if key.is_empty() {
        "codex:(unknown)".into()
    } else {
        format!("codex:{key}")
    }
}

pub fn cwd_key(path: &str) -> String {
    let stripped = strip_verbatim_prefix(path.trim());
    let trimmed = stripped.trim_end_matches(['\\', '/']);
    #[cfg(windows)]
    {
        trimmed.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        trimmed.to_string()
    }
}

pub fn thread_title(name: Option<&str>, preview: Option<&str>) -> String {
    let name = name.unwrap_or("").trim();
    if !name.is_empty() {
        return take_chars(name, 48);
    }
    let preview = preview.unwrap_or("").trim();
    let line = preview.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        "未命名会话".into()
    } else {
        take_chars(line, 48)
    }
}

pub fn status_from_thread(status: &Value) -> SessionStatus {
    let kind = status.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "systemError" => SessionStatus::Failed,
        "active" => {
            let waiting = status
                .get("activeFlags")
                .and_then(Value::as_array)
                .map(|flags| {
                    flags.iter().any(|flag| {
                        matches!(
                            flag.as_str(),
                            Some("waitingOnApproval" | "waitingOnUserInput")
                        )
                    })
                })
                .unwrap_or(false);
            if waiting {
                SessionStatus::NeedsInput
            } else {
                SessionStatus::Running
            }
        }
        _ => SessionStatus::Completed,
    }
}

pub fn parse_thread(value: &Value) -> Option<CodexThread> {
    let id = value.get("id").and_then(Value::as_str)?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    let cwd = strip_verbatim_prefix(value.get("cwd").and_then(Value::as_str).unwrap_or(""));
    let ephemeral = value
        .get("ephemeral")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(CodexThread {
        title: thread_title(
            value.get("name").and_then(Value::as_str),
            value.get("preview").and_then(Value::as_str),
        ),
        key: cwd_key(&cwd),
        cwd,
        created_at: unix_millis(value.get("createdAt")),
        updated_at: unix_millis(value.get("updatedAt")),
        status: status_from_thread(value.get("status").unwrap_or(&Value::Null)),
        ephemeral,
        id,
    })
}

/// `thread/turns/list` 按更新时间倒序分页。翻回时间顺序后再渲染。
pub fn chronological_turns(pages_newest_first: &[Vec<Value>]) -> Vec<Value> {
    let mut turns = Vec::new();
    for page in pages_newest_first.iter().rev() {
        turns.extend(page.iter().rev().cloned());
    }
    turns
}

pub fn bodies_from_turns(turns: &[Value]) -> Vec<SessionEventBody> {
    let mut bodies = Vec::new();
    for turn in turns {
        let Some(items) = turn.get("items").and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            push_history_item(&mut bodies, item);
        }
    }
    bodies
}

pub const HISTORY_TURN_LIMIT: u32 = HISTORY_PAGE;
pub const HISTORY_PAGE_CAP: usize = HISTORY_PAGES;

fn push_history_item(bodies: &mut Vec<SessionEventBody>, item: &Value) {
    match item.get("type").and_then(Value::as_str).unwrap_or("") {
        "userMessage" => {
            let text = user_item_text(item);
            if !text.is_empty() {
                bodies.push(SessionEventBody::UserMessage {
                    text: take_chars(&text, 20_000),
                });
            }
        }
        "agentMessage" => {
            let text = item.get("text").and_then(Value::as_str).unwrap_or("");
            if !text.is_empty() {
                bodies.push(SessionEventBody::AgentMessage {
                    text: take_chars(text, 20_000),
                    stream_id: None,
                });
            }
        }
        "reasoning" => {
            let text = reasoning_text(item);
            if !text.trim().is_empty() {
                bodies.push(SessionEventBody::Thinking {
                    text: take_chars(&text, 20_000),
                    stream_id: None,
                });
            }
        }
        "commandExecution" => {
            let command = item.get("command").and_then(Value::as_str).unwrap_or("");
            let status = item.get("status").and_then(Value::as_str).unwrap_or("");
            let mut summary = if status.is_empty() {
                command.to_string()
            } else {
                format!("{command} → {status}")
            };
            if let Some(output) = item.get("aggregatedOutput").and_then(Value::as_str) {
                let output = output.trim();
                if !output.is_empty() {
                    summary.push('\n');
                    summary.push_str(&take_chars(output, 240));
                }
            }
            if !summary.trim().is_empty() {
                bodies.push(SessionEventBody::ToolCall {
                    name: "command".into(),
                    summary,
                });
            }
        }
        _ => {}
    }
}

pub fn reasoning_text(item: &Value) -> String {
    let summary = joined_parts(item.get("summary"));
    if !summary.trim().is_empty() {
        return summary;
    }
    joined_parts(item.get("content"))
}

fn joined_parts(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(part_text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn part_text(part: &Value) -> Option<String> {
    match part {
        Value::String(text) => Some(text.clone()),
        Value::Object(_) => part.get("text").and_then(Value::as_str).map(str::to_string),
        _ => None,
    }
}

fn user_item_text(item: &Value) -> String {
    match item.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                let kind = part.get("type").and_then(Value::as_str).unwrap_or("text");
                if kind == "text" || kind == "input_text" {
                    part.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn folder_name(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    trimmed
        .rsplit(['\\', '/'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("未知目录")
        .to_string()
}

fn unix_millis(value: Option<&Value>) -> i64 {
    let Some(value) = value else {
        return 0;
    };
    let raw = value
        .as_i64()
        .or_else(|| value.as_f64().map(|n| n as i64))
        .unwrap_or(0);
    if raw > 10_000_000_000 {
        raw
    } else {
        raw.saturating_mul(1000)
    }
}

fn take_chars(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(max).collect();
        out.push('…');
        out
    }
}

struct RpcClient {
    out: mpsc::UnboundedSender<String>,
    child: Mutex<Option<Child>>,
    next_id: AtomicU64,
    waiters: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
}

impl RpcClient {
    async fn spawn() -> Result<Self, String> {
        let bin = resolve_codex_bin()?;
        let mut command = Command::new(bin);
        command
            .arg("app-server")
            .env_remove("TERM")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        apply_loopback_no_proxy(&mut command);
        apply_utf8_env(&mut command);
        hide_console(&mut command);
        let mut child = command
            .spawn()
            .map_err(|err| format!("无法启动 Codex CLI：{err}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Codex CLI 没有标准输入".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex CLI 没有标准输出".to_string())?;
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(line) = out_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                    || stdin.flush().await.is_err()
                {
                    break;
                }
            }
        });
        let waiters: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let reader_waiters = Arc::clone(&waiters);
        let reply = out_tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout);
            let mut raw = Vec::new();
            loop {
                raw.clear();
                let Ok(n) = lines.read_until(b'\n', &mut raw).await else {
                    break;
                };
                if n == 0 {
                    break;
                }
                if raw.last() == Some(&b'\n') {
                    raw.pop();
                }
                if raw.last() == Some(&b'\r') {
                    raw.pop();
                }
                let line = decode_child_bytes(&raw);
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    if message.get("method").is_some() {
                        answer_server_request(&reply, id, &message);
                        continue;
                    }
                    if let Some(waiter) = reader_waiters.lock().unwrap().remove(&id) {
                        let _ = waiter.send(message);
                    }
                }
            }
        });
        let client = Self {
            out: out_tx,
            child: Mutex::new(Some(child)),
            next_id: AtomicU64::new(1),
            waiters,
        };
        client
            .request(
                "initialize",
                json!({
                    "clientInfo": { "name": "ai-workbench", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "experimentalApi": true }
                }),
                Duration::from_secs(30),
            )
            .await?;
        client.notify("initialized", json!({}));
        Ok(client)
    }

    async fn list_pages(&self) -> Result<Vec<CodexThread>, String> {
        let mut cursor: Option<String> = None;
        let mut threads = Vec::new();
        for _ in 0..MAX_PAGES {
            let mut params = json!({
                "archived": false,
                "limit": PAGE_LIMIT,
                "sortKey": "updated_at",
                "sortDirection": "desc",
            });
            if let Some(cursor) = &cursor {
                params["cursor"] = json!(cursor);
            }
            let page = self
                .request("thread/list", params, Duration::from_secs(60))
                .await?;
            let data = page
                .get("data")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for item in &data {
                if let Some(thread) = parse_thread(item) {
                    if !thread.ephemeral {
                        threads.push(thread);
                    }
                }
            }
            cursor = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|cursor| !cursor.is_empty())
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(threads)
    }

    fn notify(&self, method: &str, params: Value) {
        let line = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        })
        .to_string();
        let _ = self.out.send(line);
    }

    async fn request(&self, method: &str, params: Value, budget: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.waiters.lock().unwrap().insert(id, tx);
        let line = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        })
        .to_string();
        if self.out.send(line).is_err() {
            self.waiters.lock().unwrap().remove(&id);
            return Err("无法向 Codex CLI 写入消息".into());
        }
        match timeout(budget, rx).await {
            Ok(Ok(message)) => {
                if let Some(err) = message.get("error") {
                    Err(err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex 返回错误")
                        .to_string())
                } else {
                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                }
            }
            _ => {
                self.waiters.lock().unwrap().remove(&id);
                Err(format!("等待 Codex {method} 超时"))
            }
        }
    }
}

impl Drop for RpcClient {
    fn drop(&mut self) {
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.start_kill();
        }
    }
}

fn answer_server_request(out: &mpsc::UnboundedSender<String>, id: u64, message: &Value) {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let result = if method == "currentTime/read" {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        json!({ "currentTimeAt": now })
    } else {
        let line = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": "ai-workbench 目录进程不处理该请求" }
        })
        .to_string();
        let _ = out.send(line);
        return;
    };
    let line = json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string();
    let _ = out.send(line);
}

fn resolve_codex_bin() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CODEX_BIN").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
    }
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_var) {
        let exe = dir.join("codex.exe");
        if exe.is_file() {
            return Ok(exe);
        }
    }
    for dir in std::env::split_paths(&path_var) {
        for name in ["codex.cmd", "codex.ps1", "codex"] {
            let shim = dir.join(name);
            if shim.is_file() {
                if let Some(found) = vendor_exe_near(&shim) {
                    return Ok(found);
                }
            }
        }
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let candidate = PathBuf::from(appdata).join(
            "npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
        );
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("未找到 Codex CLI。请先安装并确保 `codex` 在 PATH 中。".into())
}

fn vendor_exe_near(shim: &Path) -> Option<PathBuf> {
    let parent = shim.parent()?;
    let rel = Path::new("node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
    [parent.join(rel), parent.join("..").join(rel)]
        .into_iter()
        .find(|path| path.is_file())
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    let _ = command;
}

fn apply_loopback_no_proxy(command: &mut Command) {
    let current = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .unwrap_or_default();
    let mut parts = Vec::new();
    for item in current.split(',') {
        let item = item.trim();
        if item.is_empty()
            || parts
                .iter()
                .any(|existing: &String| existing.eq_ignore_ascii_case(item))
        {
            continue;
        }
        parts.push(item.to_string());
    }
    for host in ["localhost", "127.0.0.1", "::1"] {
        if !parts.iter().any(|existing| existing.eq_ignore_ascii_case(host)) {
            parts.push(host.to_string());
        }
    }
    let value = parts.join(",");
    command.env("NO_PROXY", &value);
    command.env("no_proxy", &value);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project(id: &str, path: &str) -> Project {
        Project {
            id: id.into(),
            name: "已保存".into(),
            path: path.into(),
            default_agent: AgentKind::CodexCli,
            created_at: 1,
            updated_at: 2,
            external: false,
        }
    }

    fn thread(id: &str, cwd: &str, updated: i64) -> CodexThread {
        CodexThread {
            id: id.into(),
            key: cwd_key(cwd),
            cwd: cwd.into(),
            title: id.into(),
            created_at: updated - 10,
            updated_at: updated,
            status: SessionStatus::Completed,
            ephemeral: false,
        }
    }

    #[test]
    fn cwd_key_ignores_verbatim_prefix_and_case() {
        assert_eq!(cwd_key(r"\\?\F:\App\"), cwd_key(r"f:\app"));
    }

    #[test]
    fn title_prefers_name_then_preview() {
        assert_eq!(thread_title(Some("概括当前项目"), Some("别的")), "概括当前项目");
        assert_eq!(thread_title(Some("  "), Some("第一行\n第二行")), "第一行");
        assert_eq!(thread_title(None, Some("   ")), "未命名会话");
    }

    #[test]
    fn status_maps_active_flags() {
        assert_eq!(
            status_from_thread(&json!({"type": "idle"})),
            SessionStatus::Completed
        );
        assert_eq!(
            status_from_thread(&json!({"type": "notLoaded"})),
            SessionStatus::Completed
        );
        assert_eq!(
            status_from_thread(&json!({"type": "systemError"})),
            SessionStatus::Failed
        );
        assert_eq!(
            status_from_thread(&json!({"type": "active", "activeFlags": ["waitingOnApproval"]})),
            SessionStatus::NeedsInput
        );
        assert_eq!(
            status_from_thread(&json!({"type": "active", "activeFlags": []})),
            SessionStatus::Running
        );
    }

    #[test]
    fn groups_resume_cwds_without_replacing_saved_projects() {
        let stored = vec![project("saved", r"F:\app")];
        let threads = vec![
            thread("inside", r"f:\app", 50),
            thread("outside", r"D:\other\demo", 80),
            thread("outside-2", r"D:\other\demo", 90),
        ];
        let projects = group_projects(&stored, &threads);
        assert_eq!(projects.len(), 2);
        assert!(!projects[0].external);
        assert_eq!(projects[0].id, "saved");
        assert!(projects[1].external);
        assert_eq!(projects[1].name, "demo");
        assert_eq!(projects[1].id, virtual_project_id(&cwd_key(r"D:\other\demo")));

        let saved_sessions = sessions_for_project(&projects[0], &threads);
        assert_eq!(saved_sessions.len(), 1);
        assert_eq!(saved_sessions[0].id, "inside");
        assert_eq!(saved_sessions[0].project_id, "saved");

        let external_sessions = sessions_for_project(&projects[1], &threads);
        assert_eq!(external_sessions.len(), 2);
        assert_eq!(external_sessions[0].id, "outside-2");
    }

    #[test]
    fn skips_ephemeral_threads_when_grouping() {
        let mut ghost = thread("temp", r"F:\scratch", 10);
        ghost.ephemeral = true;
        let projects = group_projects(&[], &[ghost]);
        assert!(projects.is_empty());
    }

    #[test]
    fn parses_thread_list_item_without_using_a_local_id() {
        let parsed = parse_thread(&json!({
            "id": "01a12492-d8e5-7e40-b438-95315ee95f7c",
            "cwd": r"\\?\F:\mercury_resource\client\mercury_dev",
            "preview": "概括当前项目",
            "name": "概括当前项目",
            "ephemeral": false,
            "createdAt": 1_791_616_756_i64,
            "updatedAt": 1_791_616_800_i64,
            "status": { "type": "notLoaded" }
        }))
        .unwrap();
        assert_eq!(parsed.id, "01a12492-d8e5-7e40-b438-95315ee95f7c");
        assert_eq!(parsed.cwd, r"F:\mercury_resource\client\mercury_dev");
        assert_eq!(parsed.title, "概括当前项目");
        assert_eq!(parsed.created_at, 1_791_616_756_000);
        assert_eq!(parsed.status, SessionStatus::Completed);
    }

    #[test]
    fn history_turns_are_chronological_and_map_messages() {
        let older = vec![json!({"id": "t1", "items": [{"type": "userMessage", "content": [{"type": "text", "text": "你好"}]}]})];
        let newer = vec![json!({"id": "t2", "items": [{"type": "agentMessage", "text": "完成"}]})];
        let turns = chronological_turns(&[newer, older]);
        let bodies = bodies_from_turns(&turns);
        assert!(matches!(bodies[0], SessionEventBody::UserMessage { ref text } if text == "你好"));
        assert!(matches!(bodies[1], SessionEventBody::AgentMessage { ref text, .. } if text == "完成"));
    }

    #[test]
    fn history_prefers_reasoning_summary_over_content() {
        let turns = vec![json!({
            "items": [{
                "type": "reasoning",
                "id": "r1",
                "summary": [{ "type": "summary_text", "text": "先看入口" }],
                "content": ["更长的原文"]
            }]
        })];
        let bodies = bodies_from_turns(&turns);
        assert!(matches!(
            bodies[0],
            SessionEventBody::Thinking { ref text, stream_id: None } if text == "先看入口"
        ));
    }

    #[tokio::test]
    #[ignore = "calls the local Codex CLI"]
    async fn lists_interactive_resume_threads() {
        let directory = CodexDirectory::new();
        let threads = directory.list_threads().await.expect("thread/list");
        assert!(!threads.is_empty(), "codex resume --all equivalent list was empty");
        assert!(threads.iter().all(|thread| !thread.id.is_empty()));
        assert!(threads.iter().all(|thread| !thread.ephemeral));
        let again = directory.list_threads().await.expect("cached");
        assert_eq!(again.len(), threads.len());
        eprintln!("interactive resume threads: {}", threads.len());
    }

    #[tokio::test]
    #[ignore = "calls the local Codex CLI"]
    async fn resumes_an_existing_thread_by_its_id() {
        use crate::agents::codex_cli::CodexCliAdapter;
        use crate::agents::{AgentAdapter, SessionContext};
        use tokio::sync::mpsc;

        let directory = CodexDirectory::new();
        let threads = directory.list_threads().await.expect("thread/list");
        let thread = threads
            .iter()
            .rev()
            .find(|thread| !thread.cwd.is_empty())
            .expect("resume list has a thread");
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = CodexCliAdapter::new()
            .start_session(
                SessionContext {
                    session_id: thread.id.clone(),
                    project_path: thread.cwd.clone(),
                    access_mode: None,
                    resume_thread_id: Some(thread.id.clone()),
                    persist_thread: true,
                },
                tx,
            )
            .await
            .expect("resume");
        assert_eq!(session.native_thread_id().as_deref(), Some(thread.id.as_str()));
        let mut saw_history = false;
        while let Ok(body) = rx.try_recv() {
            if matches!(
                body,
                SessionEventBody::UserMessage { .. } | SessionEventBody::AgentMessage { .. }
            ) {
                saw_history = true;
            }
        }
        let _ = session.stop().await;
        assert!(saw_history, "resumed thread did not load any messages");
    }

    #[tokio::test]
    #[ignore = "calls the local Codex CLI"]
    async fn persistent_start_shows_up_in_resume_list_then_is_deleted() {
        use crate::agents::codex_cli::CodexCliAdapter;
        use crate::agents::{AgentAdapter, SessionContext};
        use tokio::sync::mpsc;

        let dir = std::env::temp_dir().join(format!(
            "ai-workbench-resume-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp cwd");
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = CodexCliAdapter::new()
            .start_session(
                SessionContext {
                    session_id: String::new(),
                    project_path: dir.display().to_string(),
                    access_mode: Some("full".into()),
                    resume_thread_id: None,
                    persist_thread: true,
                },
                tx,
            )
            .await
            .expect("thread/start");
        let id = session.native_thread_id().expect("native thread id");
        assert!(!id.is_empty());
        let send = session
            .send_message("Reply with the single word ok. Do not use tools.".into())
            .await;
        let mut saw_reply = false;
        if send.is_ok() {
            let deadline = std::time::Instant::now() + Duration::from_secs(90);
            while std::time::Instant::now() < deadline {
                match timeout(Duration::from_millis(500), rx.recv()).await {
                    Ok(Some(SessionEventBody::AgentMessage { text, .. })) if !text.trim().is_empty() => {
                        saw_reply = true;
                        break;
                    }
                    Ok(Some(SessionEventBody::Error { message })) => {
                        panic!("codex turn failed: {message}");
                    }
                    Ok(None) => break,
                    _ => {}
                }
            }
        }

        let directory = CodexDirectory::new();
        let listed = directory.list_threads().await;
        let found = listed
            .as_ref()
            .map(|threads| threads.iter().any(|thread| thread.id == id))
            .unwrap_or(false);
        let _ = session.stop().await;

        let client = RpcClient::spawn().await.expect("delete client");
        let deleted = client
            .request(
                "thread/delete",
                json!({ "threadId": id }),
                Duration::from_secs(30),
            )
            .await;
        drop(client);
        let _ = std::fs::remove_dir_all(&dir);

        assert!(send.is_ok(), "send failed: {send:?}");
        assert!(saw_reply, "Codex did not answer");
        assert!(listed.is_ok(), "thread/list failed: {listed:?}");
        assert!(found, "new thread {id} is missing from codex resume list");
        deleted.expect("thread/delete");
    }
}
