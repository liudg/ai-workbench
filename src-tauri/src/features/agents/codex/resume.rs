//! Codex 会话目录：`thread/list` 等同于 `codex resume --all`。
//!
//! 实现 [`SessionDirectory`](crate::features::agents::directory::SessionDirectory)。
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
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

use async_trait::async_trait;

use crate::encoding::{apply_utf8_env, decode_child_bytes};
use crate::features::agents::directory::{cwd_key, DirectoryEntry, SessionDirectory};
use crate::models::{strip_verbatim_prefix, MessagePhase, SessionEventBody, SessionStatus};

use super::process::{apply_codex_network_env, hide_console, resolve_codex_bin};

const CACHE_TTL: Duration = Duration::from_secs(8);
const PAGE_LIMIT: u32 = 100;
const MAX_PAGES: usize = 40;
const HISTORY_PAGE: u32 = 20;
const TOOL_DETAIL_CAP: usize = 20_000;

pub struct CodexDirectory {
    inner: tokio::sync::Mutex<DirectoryState>,
}

struct DirectoryState {
    client: Option<RpcClient>,
    active: Option<Cache>,
    generation: u64,
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
                active: None,
                generation: 0,
            }),
        }
    }

    /// 侧边栏列表和生命周期 RPC 共用一个 app-server。
    pub fn shared() -> Arc<Self> {
        static DIR: OnceLock<Arc<CodexDirectory>> = OnceLock::new();
        DIR.get_or_init(|| Arc::new(CodexDirectory::new())).clone()
    }

    pub async fn invalidate(&self) {
        let mut state = self.inner.lock().await;
        state.active = None;
        state.generation = state.generation.wrapping_add(1);
    }

    /// 交互、未归档的全部线程。短时间内复用上一次结果，避免每个项目都拉起进程。
    pub async fn list_threads(&self) -> Result<Vec<DirectoryEntry>, String> {
        let mut state = self.inner.lock().await;
        if let Some(cache) = &state.active {
            if cache.at.elapsed() < CACHE_TTL {
                return cache.result.clone();
            }
        }
        let generation = state.generation;
        let result = fetch_threads(&mut state.client, false).await;
        if state.generation == generation {
            state.active = Some(Cache {
                at: Instant::now(),
                result: result.clone(),
            });
        }
        result
    }

    pub async fn rename_thread(&self, native_id: &str, name: &str) -> Result<(), String> {
        self.rpc(
            "thread/name/set",
            json!({ "threadId": native_id, "name": name }),
        )
        .await?;
        self.invalidate().await;
        Ok(())
    }

    pub async fn delete_thread(&self, native_id: &str) -> Result<(), String> {
        self.rpc("thread/delete", json!({ "threadId": native_id }))
            .await?;
        self.invalidate().await;
        Ok(())
    }

    /// 桌面端参数：`excludeTurns: true` 只缩小回包，历史仍会复制。
    ///
    /// 不用常驻目录进程：它调用 `thread/fork` 后会成为新线程的 active writer，
    /// 随后会话里的 `thread/resume` 只能只读打开。
    pub async fn fork_thread(&self, native_id: &str) -> Result<DirectoryEntry, String> {
        let client = RpcClient::spawn().await?;
        let result = client
            .request(
                "thread/fork",
                json!({
                    "threadId": native_id,
                    "excludeTurns": true,
                    "threadSource": "user",
                }),
                Duration::from_secs(60),
            )
            .await;
        client.shutdown().await;
        let result = result?;
        let thread = result.get("thread").cloned().unwrap_or(result);
        let entry = parse_thread(&thread).ok_or_else(|| "创建聊天分支失败".to_string())?;
        self.invalidate().await;
        Ok(entry)
    }

    #[allow(dead_code)]
    #[cfg(test)]
    pub async fn read_cwd(&self, native_id: &str) -> Result<String, String> {
        let result = self
            .rpc(
                "thread/read",
                json!({ "threadId": native_id, "includeTurns": false }),
            )
            .await?;
        cwd_from_thread_payload(&result).ok_or_else(|| "无法读取聊天目录".to_string())
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut state = self.inner.lock().await;
        rpc_retry(&mut state.client, method, params).await
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

async fn fetch_threads(
    client: &mut Option<RpcClient>,
    archived: bool,
) -> Result<Vec<DirectoryEntry>, String> {
    let mut last_err = String::from("无法读取 Codex 会话");
    for attempt in 0..2 {
        if client.is_none() {
            *client = Some(RpcClient::spawn().await?);
        }
        match client.as_ref().unwrap().list_pages(archived).await {
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

async fn rpc_retry(
    client: &mut Option<RpcClient>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let mut last_err = format!("无法调用 Codex {method}");
    for attempt in 0..2 {
        if client.is_none() {
            *client = Some(RpcClient::spawn().await?);
        }
        match client
            .as_ref()
            .unwrap()
            .request(method, params.clone(), Duration::from_secs(60))
            .await
        {
            Ok(value) => return Ok(value),
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

#[allow(dead_code)]
#[cfg(test)]
fn cwd_from_thread_payload(value: &Value) -> Option<String> {
    let thread = value.get("thread").unwrap_or(value);
    let cwd = strip_verbatim_prefix(thread.get("cwd").and_then(Value::as_str).unwrap_or(""));
    if cwd.is_empty() {
        None
    } else {
        Some(cwd)
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
    let archived = value
        .get("archived")
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
        archived,
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
        let turn_id = turn
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let Some(items) = turn.get("items").and_then(Value::as_array) else {
            continue;
        };
        let plan = items
            .iter()
            .any(|item| item.get("type").and_then(Value::as_str) == Some("plan"));
        let mut anchored = false;
        let mut review: Option<(String, String)> = None;
        let mut files = Vec::new();
        for item in items {
            let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
            if kind == "userMessage" && !anchored && !turn_id.is_empty() {
                push_history_item(&mut bodies, &turn_id, plan, &mut files, item);
                bodies.push(SessionEventBody::TurnAnchor {
                    turn_id: turn_id.clone(),
                    mode: plan.then(|| "plan".to_string()),
                });
                anchored = true;
                continue;
            }
            if kind == "agentMessage" {
                let text = item
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if let Some((id, stored)) = review.clone() {
                    if stored == text && !text.is_empty() {
                        review = None;
                        bodies.push(SessionEventBody::AgentMessage {
                            text: take_chars(&text, 20_000),
                            stream_id: None,
                            phase: MessagePhase::parse(item.get("phase").and_then(Value::as_str)),
                            mode: plan.then(|| "plan".to_string()),
                            dedupe_of: Some(id),
                        });
                        continue;
                    }
                }
            }
            if kind == "exitedReviewMode" {
                let text = item.get("review").and_then(Value::as_str).unwrap_or("");
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    let id = item
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .unwrap_or("review")
                        .to_string();
                    review = Some((id, trimmed.to_string()));
                }
            }
            push_history_item(&mut bodies, &turn_id, plan, &mut files, item);
        }
        let turn_diff = turn.get("diff").and_then(Value::as_str).unwrap_or("");
        let mut summarized = false;
        if !turn_id.is_empty() && !turn_diff.is_empty() {
            let had_files = !files.is_empty();
            files = crate::features::agents::changes::overlay_unified_diff(&files, turn_diff);
            if had_files {
                crate::features::agents::changes::sync_file_change_counts(
                    &mut bodies,
                    &turn_id,
                    &files,
                );
            } else if !files.is_empty() {
                crate::features::agents::changes::push_file_change_events(
                    &mut bodies,
                    &turn_id,
                    &files,
                );
                summarized = true;
            }
            bodies.push(SessionEventBody::TurnDiff {
                turn_id: turn_id.clone(),
                diff: turn_diff.to_string(),
            });
        }
        if !files.is_empty() && !summarized {
            crate::features::agents::changes::sync_file_change_counts(
                &mut bodies,
                &turn_id,
                &files,
            );
            bodies.push(SessionEventBody::TurnChanges { turn_id, files });
        }
    }
    bodies
}

pub const HISTORY_TURN_LIMIT: u32 = HISTORY_PAGE;

fn push_history_item(
    bodies: &mut Vec<SessionEventBody>,
    turn_id: &str,
    plan: bool,
    files: &mut Vec<crate::models::FileChange>,
    item: &Value,
) {
    if item.get("type").and_then(Value::as_str) == Some("fileChange") {
        let parsed = crate::features::agents::changes::file_changes_from_codex(
            item.get("changes").unwrap_or(&serde_json::Value::Null),
        );
        *files = crate::features::agents::changes::merge_file_list(files, &parsed);
        for file in &parsed {
            let stored = files
                .iter()
                .find(|item| crate::features::agents::changes::same_file(&item.path, &file.path))
                .unwrap_or(file);
            bodies.push(SessionEventBody::FileChange {
                turn_id: turn_id.to_string(),
                path: stored.path.clone(),
                status: stored.status,
                added: stored.added,
                removed: stored.removed,
                diff: stored.diff.clone(),
            });
        }
        return;
    }
    if let Some(view) = tool_view(item) {
        if tool_visible(&view) {
            bodies.push(tool_event(view, None));
        }
        return;
    }
    match item.get("type").and_then(Value::as_str).unwrap_or("") {
        "userMessage" => {
            let text = user_item_text(item);
            let text = super::prompts::async_reply_display(&text).unwrap_or(text);
            let images = user_item_images(item)
                .into_iter()
                .map(|image| take_chars(&image, 20_000))
                .collect::<Vec<_>>();
            if !text.is_empty() || !images.is_empty() {
                bodies.push(SessionEventBody::UserMessage {
                    text: take_chars(&text, 20_000),
                    images,
                    annotations: 0,
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
                    mode: plan.then(|| "plan".to_string()),
                    dedupe_of: None,
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
        "plan" => {
            let text = item.get("text").and_then(Value::as_str).unwrap_or("");
            if !text.is_empty() {
                bodies.push(SessionEventBody::PlanText {
                    text: take_chars(text, 20_000),
                    stream_id: None,
                    mode: Some("plan".into()),
                });
            }
        }
        "enteredReviewMode" => {
            let text = item.get("review").and_then(Value::as_str).unwrap_or("");
            if !text.is_empty() {
                bodies.push(SessionEventBody::ReviewNote {
                    text: take_chars(text, 4_000),
                });
            }
        }
        "exitedReviewMode" => {
            let text = item.get("review").and_then(Value::as_str).unwrap_or("");
            if !text.trim().is_empty() {
                bodies.push(super::gap::parse_review_output(text));
            }
        }
        _ => {}
    }
}

pub(super) struct ToolView {
    pub(super) name: String,
    pub(super) summary: String,
    pub(super) detail: String,
    pub(super) images: Vec<String>,
}

pub(super) fn tool_view(item: &Value) -> Option<ToolView> {
    match item.get("type").and_then(Value::as_str).unwrap_or("") {
        "commandExecution" => Some(command_view(item)),
        "mcpToolCall" => Some(mcp_view(item)),
        "webSearch" => Some(web_view(item)),
        kind if image_item_kind(kind) => Some(image_view(item)),
        _ => None,
    }
}

pub(super) fn tool_event(view: ToolView, stream_id: Option<String>) -> SessionEventBody {
    SessionEventBody::ToolCall {
        name: view.name,
        summary: view.summary,
        detail: take_chars(&view.detail, TOOL_DETAIL_CAP),
        stream_id,
        images: view
            .images
            .into_iter()
            .map(|image| take_chars(&image, TOOL_DETAIL_CAP))
            .collect(),
    }
}

pub(super) fn tool_visible(view: &ToolView) -> bool {
    !view.summary.trim().is_empty() || !view.detail.trim().is_empty() || !view.images.is_empty()
}

fn command_view(item: &Value) -> ToolView {
    ToolView {
        name: "command".into(),
        summary: command_summary(item),
        detail: command_output(item),
        images: Vec::new(),
    }
}

fn command_summary(item: &Value) -> String {
    let command = item.get("command").and_then(Value::as_str).unwrap_or("");
    let status = item.get("status").and_then(Value::as_str).unwrap_or("");
    let exit = item
        .get("exitCode")
        .and_then(Value::as_i64)
        .map(|code| format!("，退出码 {code}"))
        .unwrap_or_default();
    if status.is_empty() {
        format!("{command}{exit}")
    } else {
        format!("{command} → {status}{exit}")
    }
}

fn command_output(item: &Value) -> String {
    let mut parts = Vec::new();
    for key in ["aggregatedOutput", "output", "stdout", "stderr"] {
        let Some(text) = item.get(key).and_then(Value::as_str) else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() || parts.iter().any(|existing: &String| existing == text) {
            continue;
        }
        parts.push(text.to_string());
    }
    parts.join("\n")
}

fn mcp_view(item: &Value) -> ToolView {
    let tool = item.get("tool").and_then(Value::as_str).unwrap_or("mcp");
    let server = item
        .get("server")
        .or_else(|| item.get("serverName"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut parts = Vec::new();
    if let Some(args) = item.get("arguments").or_else(|| item.get("input")) {
        if !args.is_null() {
            parts.push(format!("参数\n{}", pretty_value(args)));
        }
    }
    if let Some(result) = item.get("result").or_else(|| item.get("output")) {
        if !result.is_null() {
            parts.push(format!("结果\n{}", pretty_value(result)));
        }
    }
    if let Some(err) = item.get("error") {
        if !err.is_null() {
            parts.push(format!("错误\n{}", pretty_value(err)));
        }
    }
    ToolView {
        name: tool.to_string(),
        summary: format!("MCP {server} {tool}").trim().to_string(),
        detail: parts.join("\n\n"),
        images: Vec::new(),
    }
}

fn web_view(item: &Value) -> ToolView {
    let query = item.get("query").and_then(Value::as_str).unwrap_or("");
    let mut parts = Vec::new();
    if let Some(action) = item.get("action") {
        if !action.is_null() {
            parts.push(pretty_value(action));
        }
    }
    if let Some(results) = item.get("results").or_else(|| item.get("output")) {
        if !results.is_null() {
            parts.push(pretty_value(results));
        }
    }
    ToolView {
        name: "web_search".into(),
        summary: query.to_string(),
        detail: parts.join("\n\n"),
        images: Vec::new(),
    }
}

fn image_item_kind(kind: &str) -> bool {
    matches!(
        kind.replace('_', "").to_ascii_lowercase().as_str(),
        "image" | "imageview" | "imagegeneration" | "localimage"
    )
}

fn image_view(item: &Value) -> ToolView {
    let mut images = user_item_images(item);
    if let Some(image) = image_from_part(item) {
        if !images.contains(&image) {
            images.push(image);
        }
    }
    for key in ["path", "url"] {
        if let Some(value) = item.get(key).and_then(Value::as_str) {
            if !value.is_empty() && !images.contains(&value.to_string()) {
                images.push(value.to_string());
            }
        }
    }
    let summary = images
        .first()
        .map(|image| {
            if image.starts_with("data:") {
                "图片".to_string()
            } else {
                image.clone()
            }
        })
        .unwrap_or_else(|| "图片".into());
    ToolView {
        name: "image".into(),
        summary,
        detail: String::new(),
        images,
    }
}

fn pretty_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
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

pub(super) fn user_item_text(item: &Value) -> String {
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

pub(super) fn user_item_images(item: &Value) -> Vec<String> {
    let parts = item
        .get("content")
        .or_else(|| item.get("input"))
        .and_then(Value::as_array);
    let Some(parts) = parts else {
        return Vec::new();
    };
    parts.iter().filter_map(image_from_part).collect()
}

pub(super) fn image_from_part(part: &Value) -> Option<String> {
    let kind = part
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .replace('_', "")
        .to_ascii_lowercase();
    if !matches!(kind.as_str(), "localimage" | "image" | "inputimage") {
        return None;
    }
    part.get("path")
        .and_then(Value::as_str)
        .or_else(|| part.get("url").and_then(Value::as_str))
        .or_else(|| part.get("image_url").and_then(Value::as_str))
        .or_else(|| part.pointer("/image_url/url").and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
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

pub(super) fn take_chars(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(max).collect();
        out.push('…');
        out
    }
}

#[cfg(test)]
pub(super) async fn delete_persisted_thread(thread_id: &str) -> Result<(), String> {
    let client = RpcClient::spawn().await?;
    let deleted = client
        .request(
            "thread/delete",
            json!({ "threadId": thread_id }),
            std::time::Duration::from_secs(30),
        )
        .await;
    drop(client);
    deleted.map(|_| ())
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

    async fn list_pages(&self, archived: bool) -> Result<Vec<DirectoryEntry>, String> {
        let mut cursor: Option<String> = None;
        let mut threads = Vec::new();
        for _ in 0..MAX_PAGES {
            let mut params = json!({
                "archived": archived,
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

    async fn request(
        &self,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, String> {
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

impl RpcClient {
    /// 关掉标准输入并等进程退出，释放线程写锁。超时再强制结束。
    async fn shutdown(self) {
        let child = self.child.lock().unwrap().take();
        drop(self);
        let Some(mut child) = child else {
            return;
        };
        if timeout(Duration::from_secs(2), child.wait()).await.is_err() {
            let _ = child.start_kill();
            let _ = child.wait().await;
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
        assert_eq!(
            thread_title(Some("概括当前项目"), Some("别的")),
            "概括当前项目"
        );
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
    fn parse_thread_reads_archived() {
        let thread = parse_thread(&json!({
            "id": "abc",
            "cwd": r"F:\app",
            "archived": true,
            "name": "已归档",
        }))
        .expect("thread");
        assert!(thread.archived);
        assert_eq!(thread.title, "已归档");
        let plain = parse_thread(&json!({"id": "def", "cwd": r"F:\app"})).expect("plain");
        assert!(!plain.archived);
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
        let older = vec![
            json!({"id": "t1", "items": [{"type": "userMessage", "content": [{"type": "text", "text": "你好"}]}]}),
        ];
        let newer = vec![json!({"id": "t2", "items": [{"type": "agentMessage", "text": "完成"}]})];
        let turns = chronological_turns(&[newer, older]);
        let bodies = bodies_from_turns(&turns);
        assert!(
            matches!(bodies[0], SessionEventBody::UserMessage { ref text, .. } if text == "你好")
        );
        assert!(
            matches!(bodies[1], SessionEventBody::TurnAnchor { ref turn_id, .. } if turn_id == "t1")
        );
        assert!(
            matches!(bodies[2], SessionEventBody::AgentMessage { ref text, phase: None, .. } if text == "完成")
        );
    }

    #[test]
    fn history_keeps_image_parts_on_the_user_message() {
        let turns = vec![json!({
            "items": [{
                "type": "userMessage",
                "content": [
                    { "type": "text", "text": "看这张" },
                    { "type": "localImage", "path": "C:/shot.png" },
                    { "type": "image", "url": "https://example.com/a.png" }
                ]
            }]
        })];
        let bodies = bodies_from_turns(&turns);
        match &bodies[0] {
            SessionEventBody::UserMessage { text, images, .. } => {
                assert_eq!(text, "看这张");
                assert_eq!(
                    images,
                    &vec![
                        "C:/shot.png".to_string(),
                        "https://example.com/a.png".to_string()
                    ]
                );
            }
            _ => panic!("expected user message"),
        }
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
        assert_eq!(
            MessagePhase::parse(Some("partial_answer")),
            Some(MessagePhase::PartialAnswer)
        );
        assert_eq!(MessagePhase::parse(Some("unknown")), None);
    }

    #[test]
    fn history_keeps_command_output_patches_mcp_and_search() {
        let output = format!("{}GAP-HISTORY-TAIL", "A".repeat(400));
        let turns = vec![json!({
            "items": [
                {
                    "type": "commandExecution",
                    "command": "echo marker",
                    "status": "completed",
                    "exitCode": 0,
                    "aggregatedOutput": output
                },
                {
                    "type": "fileChange",
                    "status": "completed",
                    "changes": [{
                        "path": "gap-history.txt",
                        "kind": "update",
                        "diff": "@@ -0,0 +1 @@\n+gap-history-marker"
                    }]
                },
                {
                    "type": "mcpToolCall",
                    "server": "docs",
                    "tool": "lookup",
                    "arguments": { "q": "codex" },
                    "result": "found"
                },
                {
                    "type": "webSearch",
                    "query": "codex desktop",
                    "results": [{ "title": "Codex" }]
                },
                {
                    "type": "imageView",
                    "path": "shot.png"
                }
            ]
        })];
        let bodies = bodies_from_turns(&turns);
        assert!(matches!(
            &bodies[0],
            SessionEventBody::ToolCall { name, detail, .. }
                if name == "command" && detail.contains("GAP-HISTORY-TAIL") && detail.len() > 240
        ));
        assert!(matches!(
            &bodies[1],
            SessionEventBody::FileChange { path, diff, .. }
                if path == "gap-history.txt" && diff.contains("gap-history-marker")
        ));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnChanges { files, .. } if files.iter().any(|file| file.path == "gap-history.txt")
        )));
        assert!(!bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::ToolCall { name, .. } if name == "apply_patch"
        )));
        assert!(matches!(
            &bodies[2],
            SessionEventBody::ToolCall { name, summary, detail, .. }
                if name == "lookup" && summary.contains("docs") && detail.contains("found")
        ));
        assert!(matches!(
            &bodies[3],
            SessionEventBody::ToolCall { name, summary, detail, .. }
                if name == "web_search" && summary == "codex desktop" && detail.contains("Codex")
        ));
        assert!(matches!(
            &bodies[4],
            SessionEventBody::ToolCall { name, images, .. }
                if name == "image" && images.as_slice() == ["shot.png"]
        ));
    }

    #[test]
    fn history_replays_file_changes_plan_mode_and_review_dedupe() {
        let review = "审查结论：通过";
        let turns = vec![json!({
            "id": "turn-plan",
            "diff": "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
            "items": [
                {"type": "userMessage", "content": [{"type": "text", "text": "做个计划"}]},
                {"type": "plan", "text": "先改 app.ts"},
                {"type": "agentMessage", "text": "计划写好了"},
                {"type": "exitedReviewMode", "id": "rev-1", "review": review},
                {"type": "agentMessage", "text": review},
                {
                    "type": "fileChange",
                    "changes": [{
                        "path": "src/app.ts",
                        "kind": "update",
                        "diff": "@@ -1 +1 @@\n-old\n+new"
                    }]
                }
            ]
        })];
        let bodies = bodies_from_turns(&turns);
        assert!(matches!(
            &bodies[1],
            SessionEventBody::TurnAnchor { turn_id, mode, .. }
                if turn_id == "turn-plan" && mode.as_deref() == Some("plan")
        ));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::PlanText { text, mode, .. }
                if text == "先改 app.ts" && mode.as_deref() == Some("plan")
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::AgentMessage { text, mode, dedupe_of, .. }
                if text == "计划写好了"
                    && mode.as_deref() == Some("plan")
                    && dedupe_of.is_none()
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::AgentMessage { text, dedupe_of, .. }
                if text == review && dedupe_of.as_deref() == Some("rev-1")
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::FileChange { turn_id, path, status, .. }
                if turn_id == "turn-plan"
                    && path == "src/app.ts"
                    && *status == crate::models::FileStatus::Modified
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnChanges { turn_id, files }
                if turn_id == "turn-plan" && files.iter().any(|file| file.path == "src/app.ts")
        )));
        assert!(!bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::ToolCall { name, .. } if name == "apply_patch"
        )));
    }

    #[test]
    fn history_replay_keeps_patch_counts_when_a_later_diff_is_empty() {
        let turns = vec![json!({
            "id": "turn-count",
            "items": [
                {"type": "userMessage", "content": [{"type": "text", "text": "改 notes"}]},
                {"type": "fileChange", "changes": [{
                    "path": "C:\\proj\\notes.md",
                    "kind": { "type": "update", "move_path": null },
                    "diff": "@@ -1 +1,2 @@\n-old\n+new-a\n+new-b\n"
                }]},
                {"type": "fileChange", "changes": [{
                    "path": "C:\\proj\\notes.md",
                    "kind": { "type": "update", "move_path": null },
                    "diff": ""
                }]}
            ]
        })];
        let bodies = bodies_from_turns(&turns);
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::FileChange { path, added, removed, .. }
                if path == "C:/proj/notes.md" && *added == 2 && *removed == 1
        )));
        assert!(bodies.iter().all(|body| !matches!(
            body,
            SessionEventBody::FileChange { added, removed, .. } if *added == 0 && *removed == 0
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnChanges { turn_id, files }
                if turn_id == "turn-count"
                    && files.len() == 1
                    && files[0].added == 2
                    && files[0].removed == 1
        )));
    }

    #[test]
    fn history_file_change_counts_unified_diff_and_diff() {
        let turns = vec![json!({
            "id": "turn-keys",
            "items": [{
                "type": "fileChange",
                "changes": [
                    {
                        "path": "from-diff.md",
                        "kind": "update",
                        "diff": "@@ -1 +1 @@\n-a\n+b\n"
                    },
                    {
                        "path": "from-unified.md",
                        "kind": "update",
                        "unified_diff": "@@ -1 +1,2 @@\n-old\n+u1\n+u2\n"
                    }
                ]
            }]
        })];
        let bodies = bodies_from_turns(&turns);
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::FileChange { path, added, removed, .. }
                if path == "from-diff.md" && *added == 1 && *removed == 1
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::FileChange { path, added, removed, .. }
                if path == "from-unified.md" && *added == 2 && *removed == 1
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnChanges { turn_id, files }
                if turn_id == "turn-keys"
                    && files.len() == 2
                    && files.iter().any(|file| file.path == "from-diff.md" && file.added == 1 && file.removed == 1)
                    && files.iter().any(|file| file.path == "from-unified.md" && file.added == 2 && file.removed == 1)
        )));
    }

    #[test]
    fn history_nonempty_diff_replaces_counts() {
        let turns = vec![json!({
            "id": "turn-replace",
            "items": [
                {"type": "fileChange", "changes": [{
                    "path": "notes.md",
                    "kind": { "type": "update", "move_path": null },
                    "diff": "@@ -1 +1,2 @@\n-old\n+new-a\n+new-b\n"
                }]},
                {"type": "fileChange", "changes": [{
                    "path": "notes.md",
                    "kind": { "type": "update", "move_path": null },
                    "unified_diff": "@@ -1 +1 @@\n-old\n+only\n"
                }]}
            ]
        })];
        let bodies = bodies_from_turns(&turns);
        let notes: Vec<_> = bodies
            .iter()
            .filter_map(|body| match body {
                SessionEventBody::FileChange {
                    path,
                    added,
                    removed,
                    diff,
                    ..
                } if path == "notes.md" => Some((*added, *removed, diff.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(notes.len(), 2);
        assert!(notes
            .iter()
            .all(|(added, removed, diff)| *added == 1 && *removed == 1 && diff.contains("+only")));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnChanges { turn_id, files }
                if turn_id == "turn-replace"
                    && files.len() == 1
                    && files[0].added == 1
                    && files[0].removed == 1
                    && files[0].diff.contains("+only")
                    && !files[0].diff.contains("+new-b")
        )));
    }

    #[test]
    fn history_turn_diff_fills_only_empty_files() {
        let turns = vec![json!({
            "id": "turn-blank",
            "diff": "diff --git a/kept.md b/kept.md\n--- a/kept.md\n+++ b/kept.md\n@@ -1 +1 @@\n-a\n+from-turn\ndiff --git a/blank.md b/blank.md\n--- a/blank.md\n+++ b/blank.md\n@@ -0,0 +1,2 @@\n+one\n+two\n",
            "items": [
                {"type": "userMessage", "content": [{"type": "text", "text": "改 notes"}]},
                {"type": "fileChange", "changes": [{
                    "path": "kept.md",
                    "kind": { "type": "update", "move_path": null },
                    "diff": "@@ -1 +1,2 @@\n-old\n+new-a\n+new-b\n"
                }]},
                {"type": "fileChange", "changes": [{
                    "path": "C:/proj/blank.md",
                    "kind": { "type": "update", "move_path": null },
                    "diff": ""
                }]}
            ]
        })];
        let bodies = bodies_from_turns(&turns);
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::FileChange { path, added, removed, diff, .. }
                if path == "kept.md"
                    && *added == 2
                    && *removed == 1
                    && diff.contains("+new-a")
                    && !diff.contains("+from-turn")
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::FileChange { path, added, removed, diff, .. }
                if path == "C:/proj/blank.md"
                    && *added == 2
                    && *removed == 0
                    && diff.contains("+one")
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnChanges { turn_id, files }
                if turn_id == "turn-blank"
                    && files.len() == 2
                    && files.iter().any(|file| {
                        file.path == "kept.md"
                            && file.added == 2
                            && file.removed == 1
                            && file.diff.contains("+new-a")
                    })
                    && files.iter().any(|file| {
                        file.path == "C:/proj/blank.md"
                            && file.added == 2
                            && file.removed == 0
                            && file.diff.contains("+two")
                    })
        )));
    }

    #[test]
    fn resume_replay_without_turn_diff_keeps_counts() {
        let newest = vec![json!({
            "id": "turn-new",
            "items": [
                {"type": "userMessage", "content": [{"type": "text", "text": "加一行"}]},
                {"type": "fileChange", "changes": [{
                    "path": "new.md",
                    "kind": "add",
                    "content": "new-line\n"
                }]}
            ]
        })];
        let older = vec![json!({
            "id": "turn-old",
            "items": [
                {"type": "userMessage", "content": [{"type": "text", "text": "改旧文件"}]},
                {"type": "fileChange", "changes": [{
                    "path": "old.md",
                    "kind": "update",
                    "diff": "@@ -1,2 +1 @@\n-a\n-b\n+c\n"
                }]}
            ]
        })];
        let turns = chronological_turns(&[newest, older]);
        assert!(turns.iter().all(|turn| turn.get("diff").is_none()));
        assert_eq!(
            turns
                .iter()
                .filter_map(|turn| turn.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            ["turn-old", "turn-new"]
        );
        let bodies = bodies_from_turns(&turns);
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnChanges { turn_id, files }
                if turn_id == "turn-old"
                    && files.len() == 1
                    && files[0].path == "old.md"
                    && files[0].added == 1
                    && files[0].removed == 2
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnChanges { turn_id, files }
                if turn_id == "turn-new"
                    && files.len() == 1
                    && files[0].path == "new.md"
                    && files[0].added == 1
                    && files[0].removed == 0
        )));
        assert!(bodies.iter().all(|body| !matches!(
            body,
            SessionEventBody::FileChange { added, removed, .. } if *added == 0 && *removed == 0
        )));
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
        assert!(
            !threads.is_empty(),
            "codex resume --all equivalent list was empty"
        );
        assert!(threads.iter().all(|thread| !thread.native_id.is_empty()));
        assert!(threads.iter().all(|thread| !thread.ephemeral));
        let again = directory.list_threads().await.expect("cached");
        assert_eq!(again.len(), threads.len());
        eprintln!("interactive resume threads: {}", threads.len());
    }

    #[tokio::test]
    #[ignore = "calls the local Codex CLI"]
    async fn resumes_an_existing_thread_by_its_id() {
        use crate::features::agents::codex::CodexCliAdapter;
        use crate::features::agents::{AgentAdapter, SessionContext};
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
                    project_path: thread.cwd.clone(),
                    access_mode: None,
                    resume_native_id: Some(thread.native_id.clone()),
                    options: serde_json::json!({ "persist": true }),
                },
                tx,
            )
            .await
            .expect("resume");
        assert_eq!(
            session.native_id().as_deref(),
            Some(thread.native_id.as_str())
        );
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
        use crate::features::agents::codex::CodexCliAdapter;
        use crate::features::agents::{AgentAdapter, SessionContext};
        use tokio::sync::mpsc;

        let dir = std::env::temp_dir().join(format!("ai-workbench-resume-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp cwd");
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = CodexCliAdapter::new()
            .start_session(
                SessionContext {
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
                    Ok(Some(SessionEventBody::AgentMessage { text, .. }))
                        if !text.trim().is_empty() =>
                    {
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

    const GAP_LIFECYCLE: &str = r"C:\Users\admin\Desktop\temp\ai-workbench-project\_gap-lifecycle";

    struct GapCleanup {
        ids: Arc<Mutex<Vec<String>>>,
    }

    impl Drop for GapCleanup {
        fn drop(&mut self) {
            let ids = self.ids.lock().unwrap().clone();
            let handle = std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("cleanup runtime");
                runtime.block_on(cleanup_gap_threads(ids));
            });
            let _ = handle.join();
        }
    }

    fn gap_key() -> String {
        cwd_key(GAP_LIFECYCLE)
    }

    async fn cleanup_gap_threads(mut ids: Vec<String>) {
        let directory = CodexDirectory::new();
        if let Ok(active) = directory.list_threads().await {
            push_gap_prefixed(&mut ids, &active);
        }
        ids.sort();
        ids.dedup();
        for id in ids {
            let Ok(cwd) = directory.read_cwd(&id).await else {
                continue;
            };
            if cwd_key(&cwd) != gap_key() {
                continue;
            }
            let _ = directory.delete_thread(&id).await;
        }
    }

    fn push_gap_prefixed(ids: &mut Vec<String>, threads: &[DirectoryEntry]) {
        for thread in threads {
            if thread.cwd_key == gap_key() && thread.title.starts_with("gap-lifecycle-") {
                ids.push(thread.native_id.clone());
            }
        }
    }

    #[tokio::test]
    #[ignore = "calls the local Codex CLI against _gap-lifecycle only"]
    async fn gap_lifecycle_rename_fork_archive_delete() {
        use crate::features::agents::codex::CodexCliAdapter;
        use crate::features::agents::{AgentAdapter, SessionContext};
        use tokio::sync::mpsc;

        std::fs::create_dir_all(GAP_LIFECYCLE).expect("gap dir");
        let ids = Arc::new(Mutex::new(Vec::new()));
        let _cleanup = GapCleanup {
            ids: Arc::clone(&ids),
        };
        let name = format!(
            "gap-lifecycle-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
        let (tx, _rx) = mpsc::unbounded_channel();
        let session = CodexCliAdapter::new()
            .start_session(
                SessionContext {
                    project_path: GAP_LIFECYCLE.into(),
                    access_mode: Some("full".into()),
                    resume_native_id: None,
                    options: json!({ "persist": true }),
                },
                tx,
            )
            .await
            .expect("thread/start");
        let id = session.native_id().expect("native thread id");
        ids.lock().unwrap().push(id.clone());
        let _ = session.stop().await;

        let adapter = CodexCliAdapter::new();
        adapter
            .rename_thread(&id, &name)
            .await
            .expect("thread/name/set");
        let forked = adapter.fork_thread(&id).await.expect("thread/fork");
        ids.lock().unwrap().push(forked.native_id.clone());

        let directory = CodexDirectory::new();
        let fork_cwd = if forked.cwd_key == gap_key() && !forked.cwd.is_empty() {
            forked.cwd.clone()
        } else {
            directory
                .read_cwd(&forked.native_id)
                .await
                .expect("fork cwd")
        };
        assert_eq!(
            cwd_key(&fork_cwd),
            gap_key(),
            "fork left the gap project: {fork_cwd}"
        );

        directory.invalidate().await;
        let active = directory.list_threads().await.expect("active list");
        let row = active
            .iter()
            .find(|thread| thread.native_id == id)
            .expect("renamed thread missing");
        assert_eq!(row.title, name);

        for native in [id, forked.native_id] {
            let cwd = directory
                .read_cwd(&native)
                .await
                .expect("cwd before delete");
            assert_eq!(
                cwd_key(&cwd),
                gap_key(),
                "refusing to delete {native} at {cwd}"
            );
            adapter.delete_thread(&native).await.expect("thread/delete");
        }
        ids.lock().unwrap().clear();
    }

    #[tokio::test]
    #[ignore = "calls the local Codex CLI in _gap-history only"]
    async fn gap_history_replays_full_command_output_and_patch() {
        use crate::features::agents::codex::CodexCliAdapter;
        use crate::features::agents::{AgentAdapter, AgentSession, SessionContext};
        use tokio::sync::mpsc;

        const GAP_HISTORY: &str = r"C:\Users\admin\Desktop\temp\ai-workbench-project\_gap-history";
        std::fs::create_dir_all(GAP_HISTORY).expect("gap history dir");
        let expected_key = cwd_key(GAP_HISTORY);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = CodexCliAdapter::new()
            .start_session(
                SessionContext {
                    project_path: GAP_HISTORY.into(),
                    access_mode: Some("full".into()),
                    resume_native_id: None,
                    options: json!({ "persist": true }),
                },
                tx,
            )
            .await
            .expect("thread/start");
        let id = session.native_id().expect("native thread id");
        let cleanup = {
            let id = id.clone();
            let expected_key = expected_key.clone();
            move || {
                let id = id.clone();
                let expected_key = expected_key.clone();
                async move {
                    let directory = CodexDirectory::new();
                    let Ok(cwd) = directory.read_cwd(&id).await else {
                        return;
                    };
                    if cwd_key(&cwd) != expected_key {
                        return;
                    }
                    let _ = directory.delete_thread(&id).await;
                }
            }
        };
        while rx.try_recv().is_ok() {}
        let send = session
            .send_message(
                "只在当前目录做两件事，然后停止：\n\
                 1. 写入文件 gap-history.txt，内容只有 gap-history-marker。\n\
                 2. 原样执行 powershell -NoProfile -Command \"Write-Output (('A'*400)+'GAP-HISTORY-TAIL')\"。\n\
                 不要概括命令输出。"
                    .into(),
            )
            .await;
        assert!(send.is_ok(), "send failed: {send:?}");
        let deadline = std::time::Instant::now() + Duration::from_secs(180);
        let mut failed = None;
        let mut saw_running = false;
        let mut finished = false;
        while std::time::Instant::now() < deadline {
            match timeout(Duration::from_millis(500), rx.recv()).await {
                Ok(Some(SessionEventBody::Error { message })) => {
                    failed = Some(message);
                    break;
                }
                Ok(Some(SessionEventBody::StatusChanged {
                    status: SessionStatus::Running,
                })) => saw_running = true,
                Ok(Some(SessionEventBody::StatusChanged {
                    status: SessionStatus::Completed | SessionStatus::Failed,
                })) if saw_running => {
                    finished = true;
                    break;
                }
                Ok(None) => break,
                _ => {}
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        let _ = session.stop().await;
        if !saw_running || !finished || failed.is_some() {
            cleanup().await;
            assert!(saw_running, "turn never started");
            assert!(finished, "turn did not finish: {failed:?}");
            if let Some(message) = failed {
                panic!("codex turn failed: {message}");
            }
        }

        let (tx, mut rx) = mpsc::unbounded_channel();
        let resumed = CodexCliAdapter::new()
            .start_session(
                SessionContext {
                    project_path: GAP_HISTORY.into(),
                    access_mode: Some("full".into()),
                    resume_native_id: Some(id.clone()),
                    options: json!({ "persist": true }),
                },
                tx,
            )
            .await
            .expect("thread/resume");
        let mut history = Vec::new();
        while let Ok(body) = rx.try_recv() {
            history.push(body);
        }
        let (older, exhausted) = AgentSession::load_older_history(&*resumed)
            .await
            .expect("older history");
        let _ = resumed.stop().await;
        cleanup().await;

        assert!(
            history.iter().all(|body| !matches!(
                body,
                SessionEventBody::System { text } if text.contains("更早的 Codex 记录没有全部载入")
            )),
            "history was still truncated"
        );
        assert!(
            history.iter().any(|body| matches!(
                body,
                SessionEventBody::ToolCall { detail, .. } if detail.contains("GAP-HISTORY-TAIL")
            )),
            "resumed history dropped the command tail: {history:?}"
        );
        let written =
            std::fs::read_to_string(format!("{GAP_HISTORY}\\gap-history.txt")).unwrap_or_default();
        assert!(
            written.contains("gap-history-marker"),
            "gap-history.txt was not written: {written:?}"
        );
        assert!(
            history.iter().any(|body| match body {
                SessionEventBody::ToolCall {
                    summary, detail, ..
                } => {
                    summary.contains("gap-history.txt")
                        || detail.contains("gap-history.txt")
                        || detail.contains("gap-history-marker")
                }
                SessionEventBody::TurnDiff { diff, .. } => {
                    diff.contains("gap-history.txt") || diff.contains("gap-history-marker")
                }
                _ => false,
            }),
            "resumed history dropped the file write: {history:?}"
        );
        assert!(exhausted, "a one-turn thread still had another page");
        assert!(older.is_empty());
    }
}
