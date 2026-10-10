//! Codex 会话目录：`thread/list` 等同于 `codex resume --all`。
//!
//! 实现 [`SessionDirectory`](crate::agents::directory::SessionDirectory)。
//! 会话 id 就是 Codex thread id。本模块只负责列出线程；真正恢复用
//! `thread/resume`，历史用 `thread/turns/list`。
//!
//! `codex resume --all` 关闭 cwd 过滤，但仍只显示交互会话（不含
//! `--include-non-interactive`，也不含已归档）。这与 app-server
//! `thread/list` 在省略 `sourceKinds`、`archived: false`、不传 `cwd` 时的
//! 结果是同一份列表。`~/.codex/session_index.jsonl` 只有 id / 标题，没有
//! cwd，而且和这份列表对不齐，所以不能当来源。
//!
//! 会话 id 就是 Codex thread id。本模块只负责列出线程；真正恢复用
//! `thread/resume`，历史用 `thread/turns/list`。

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

use async_trait::async_trait;

use crate::agents::directory::{cwd_key, DirectoryEntry, SessionDirectory};
use crate::encoding::{apply_utf8_env, decode_child_bytes};
use crate::models::{strip_verbatim_prefix, MessagePhase, SessionEventBody, SessionStatus};

use super::process::{apply_codex_network_env, hide_console, resolve_codex_bin};

const CACHE_TTL: Duration = Duration::from_secs(8);
const PAGE_LIMIT: u32 = 100;
const MAX_PAGES: usize = 40;
const HISTORY_PAGE: u32 = 20;
const HISTORY_PAGES: usize = 3;

pub struct CodexDirectory {
    inner: tokio::sync::Mutex<DirectoryState>,
}

struct DirectoryState {
    client: Option<RpcClient>,
    cache: Option<Cache>,
}

struct Cache {
    at: Instant,
    result: Result<Vec<DirectoryEntry>, String>,
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
    pub async fn list_threads(&self) -> Result<Vec<DirectoryEntry>, String> {
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

#[async_trait]
impl SessionDirectory for CodexDirectory {
    fn kind(&self) -> crate::models::AgentKind {
        crate::models::AgentKind::CodexCli
    }

    async fn list(&self) -> Result<Vec<DirectoryEntry>, String> {
        self.list_threads().await
    }

    async fn invalidate(&self) {
        CodexDirectory::invalidate(self).await
    }
}

async fn fetch_threads(client: &mut Option<RpcClient>) -> Result<Vec<DirectoryEntry>, String> {
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

pub fn parse_thread(value: &Value) -> Option<DirectoryEntry> {
    let id = value.get("id").and_then(Value::as_str)?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    let cwd = strip_verbatim_prefix(value.get("cwd").and_then(Value::as_str).unwrap_or(""));
    let ephemeral = value
        .get("ephemeral")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(DirectoryEntry {
        native_id: id,
        cwd_key: cwd_key(&cwd),
        cwd,
        title: thread_title(
            value.get("name").and_then(Value::as_str),
            value.get("preview").and_then(Value::as_str),
        ),
        created_at: unix_millis(value.get("createdAt")),
        updated_at: unix_millis(value.get("updatedAt")),
        status: status_from_thread(value.get("status").unwrap_or(&Value::Null)),
        ephemeral,
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
                    phase: MessagePhase::parse(item.get("phase").and_then(Value::as_str)),
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
        let bin = resolve_codex_bin().map_err(|err| err.to_string())?;
        let mut command = Command::new(bin);
        command
            .arg("app-server")
            .env_remove("TERM")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        apply_codex_network_env(&mut command);
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

    async fn list_pages(&self) -> Result<Vec<DirectoryEntry>, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
        assert_eq!(parsed.native_id, "01a12492-d8e5-7e40-b438-95315ee95f7c");
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
        assert!(matches!(bodies[1], SessionEventBody::AgentMessage { ref text, phase: None, .. } if text == "完成"));
    }

    #[test]
    fn history_maps_message_phase_for_every_adapter_consumer() {
        let turns = vec![json!({
            "items": [
                {"type": "userMessage", "content": [{"type": "text", "text": "看一下"}]},
                {"type": "agentMessage", "text": "我会查看目录。", "phase": "commentary"},
                {"type": "agentMessage", "text": "目录里有 src。", "phase": "final_answer"}
            ]
        })];
        let bodies = bodies_from_turns(&turns);
        assert!(matches!(
            &bodies[1],
            SessionEventBody::AgentMessage { text, phase, .. }
                if text == "我会查看目录。" && *phase == Some(MessagePhase::Commentary)
        ));
        assert!(matches!(
            &bodies[2],
            SessionEventBody::AgentMessage { text, phase, .. }
                if text == "目录里有 src。" && *phase == Some(MessagePhase::FinalAnswer)
        ));
        assert_eq!(MessagePhase::parse(Some("partial_answer")), Some(MessagePhase::PartialAnswer));
        assert_eq!(MessagePhase::parse(Some("unknown")), None);
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
        assert!(threads.iter().all(|thread| !thread.native_id.is_empty()));
        assert!(threads.iter().all(|thread| !thread.ephemeral));
        let again = directory.list_threads().await.expect("cached");
        assert_eq!(again.len(), threads.len());
        eprintln!("interactive resume threads: {}", threads.len());
    }

    #[tokio::test]
    #[ignore = "calls the local Codex CLI"]
    async fn resumes_an_existing_thread_by_its_id() {
        use crate::agents::codex::CodexCliAdapter;
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
                    session_id: thread.native_id.clone(),
                    project_path: thread.cwd.clone(),
                    access_mode: None,
                    resume_native_id: Some(thread.native_id.clone()),
                    options: serde_json::json!({ "persist": true }),
                },
                tx,
            )
            .await
            .expect("resume");
        assert_eq!(session.native_id().as_deref(), Some(thread.native_id.as_str()));
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
        use crate::agents::codex::CodexCliAdapter;
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
                    resume_native_id: None,
                    options: serde_json::json!({ "persist": true }),
                },
                tx,
            )
            .await
            .expect("thread/start");
        let id = session.native_id().expect("native thread id");
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
            .map(|threads| threads.iter().any(|thread| thread.native_id == id))
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
