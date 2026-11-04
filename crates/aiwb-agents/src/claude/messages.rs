//! stream-json 和 jsonl 正文 → 归一化事件。
//!
//! 实时 stdout 的用户原文不再写气泡（会话管理已经记过；斜杠命令也不是用户气泡）。
//! 历史里的用户正文要写入。`tool_result` 挂到对应工具行，不单独成气泡。
//! Bash / PowerShell 的工具名写成 `command`，时间线用终端图标；其它工具保留 CLI 报告的名字。
//!
//! 部分消息来自 `--include-partial-messages` 的 `stream_event`
//! （`content_block_delta` 的 `text_delta` / `thinking_delta` / `input_json_delta`）。
//! 同一 `stream_id` 会在整段会话里覆盖上一行，所以助手正文和思考按消息分开：
//! 有 Claude `uuid`（或 `message.id`）就用它；流式增量在 uuid 到达前用本回合 id 加序号，
//! 这条消息收束前一直复用，下一回合或下一条消息再换新的。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::control::{self, PermissionKind};
use super::diff;
use super::subagents;
use super::history::{conversation_chain, is_visible_message, transcript_entries};
use aiwb_core::models::{
    now_millis, FileChange, MessagePhase, PromptKind, SessionEventBody, SessionStatus, SubagentCard, ToolStatus,
};

#[derive(Default)]
pub struct MapState {
    pub seen: HashSet<String>,
    pub text: String,
    pub thinking: String,
    pub tools: HashMap<String, ToolRow>,
    partials: HashMap<i64, PartialBlock>,
    pub turn_id: String,
    /// 当前这条助手正文还在流。收束或 `begin_turn` 后清空，避免下一轮盖掉上一轮。
    text_stream_id: String,
    thinking_stream_id: String,
    stream_nonce: u64,
    pub files: Vec<FileChange>,
    /// 这一轮每个文件被改之前的原文。`files` 里的累计 diff 拿它比。
    baselines: diff::TurnBaselines,
    pub turn_diff: String,
    /// 上一轮非空 diff。`begin_turn` 会清掉当前轮，这里留下最近一次。
    saved_diff: String,
    pub model: Option<String>,
    usage: super::usage::LiveCursor,
    /// 这一轮已经给过连接或重试提示。后面的占位错误不再各画一条。
    connection_noted: bool,
    /// 这一轮已经把接口错误画成红条。后面的笼统 result 不再叠「报错」。
    turn_failure_noted: bool,
    /// 用户按下了停止。紧跟着的流中止不是断线，不画红条。
    stop_requested: bool,
    /// 正在映射的这条记录的时间：实时是收到的时刻，历史是记录里的 `timestamp`。
    pub(super) clock: Option<i64>,
    /// 子 Agent 卡片，按派它的工具调用 id。
    pub(super) subagents: HashMap<String, SubagentCard>,
    /// `task_id` → 派它的工具调用 id。
    pub(super) subagent_tasks: HashMap<String, String>,
    /// 每个子 Agent 自己的映射状态，按派它的工具调用 id。
    pub(super) children: HashMap<String, MapState>,
    /// 读历史时子 Agent 转录所在的目录（`<会话 id>/subagents`）。
    pub subagent_dir: Option<PathBuf>,
}

pub(super) struct ToolRow {
    reported: String,
    input: Value,
}

enum PartialBlock {
    Text,
    Thinking,
    Tool { id: String, name: String, json: String },
}

pub enum ControlIn {
    Response { request_id: String, result: Result<Value, String> },
    Request { request_id: String, request: Value },
    Cancel { request_id: String },
}

pub struct Ingest {
    pub events: Vec<SessionEventBody>,
    pub control: Option<ControlIn>,
}

impl MapState {
    pub fn begin_turn(&mut self, turn_id: &str) {
        if !self.turn_diff.is_empty() {
            self.saved_diff = self.turn_diff.clone();
        }
        self.text.clear();
        self.thinking.clear();
        self.partials.clear();
        self.files.clear();
        self.baselines.clear();
        self.turn_diff.clear();
        self.text_stream_id.clear();
        self.thinking_stream_id.clear();
        self.connection_noted = false;
        self.turn_failure_noted = false;
        // 新回合不沿用上一次停止，否则后面的真断线会被消掉。
        self.stop_requested = false;
        self.turn_id = turn_id.to_string();
    }

    /// 用户按下停止。下一条直播结果里的流中止不再画成断线。
    pub fn request_user_stop(&mut self) {
        self.stop_requested = true;
    }

    /// 当前轮有 diff 就用当前轮，否则用上一轮留下的。
    pub fn latest_diff(&self) -> String {
        if !self.turn_diff.is_empty() {
            self.turn_diff.clone()
        } else {
            self.saved_diff.clone()
        }
    }
}

pub fn ingest_line(state: &mut MapState, line: &str, live: bool, project: Option<&Path>) -> Ingest {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Ingest { events: Vec::new(), control: None };
    };
    ingest_value(state, &value, live, project)
}

pub fn ingest_value(state: &mut MapState, value: &Value, live: bool, project: Option<&Path>) -> Ingest {
    state.clock = if live {
        Some(now_millis())
    } else {
        value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(super::history::parse_millis)
    };
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "control_response" => {
            let control = control::parse_control_response(value).map(|(request_id, result)| {
                ControlIn::Response { request_id, result }
            });
            Ingest { events: Vec::new(), control }
        }
        "control_request" => {
            let request_id = value.get("request_id").and_then(Value::as_str).unwrap_or("").to_string();
            let request = value.get("request").cloned().unwrap_or(Value::Null);
            Ingest {
                events: Vec::new(),
                control: Some(ControlIn::Request { request_id, request }),
            }
        }
        "control_cancel_request" => {
            let request_id = value.get("request_id").and_then(Value::as_str).unwrap_or("").to_string();
            Ingest {
                events: Vec::new(),
                control: Some(ControlIn::Cancel { request_id }),
            }
        }
        "stream_event" => {
            let event = value.get("event").unwrap_or(&Value::Null);
            let mut events = if sidechain(value) { Vec::new() } else { on_stream(state, event, project) };
            if live {
                if let Some(body) = super::usage::apply_stream(&mut state.usage, event) {
                    events.push(body);
                }
            }
            Ingest { events, control: None }
        }
        "system" => Ingest { events: on_system(state, value, live), control: None },
        "assistant" => Ingest {
            events: on_assistant(state, value, project, live),
            control: None,
        },
        "user" => Ingest {
            events: on_user(state, value, live, project),
            control: None,
        },
        "result" => Ingest { events: on_result(state, value, live), control: None },
        "active_goal" => Ingest { events: on_goal(value), control: None },
        _ => Ingest { events: Vec::new(), control: None },
    }
}

pub fn events_from_transcript(state: &mut MapState, content: &str, project: Option<&Path>) -> Vec<SessionEventBody> {
    let entries = transcript_entries(content);
    // 旁路不进时间线，但 uuid 要记上，避免恢复后 stdout 回放再记一次用量。
    for entry in &entries {
        if flag(entry, "isSidechain") {
            let _ = skip_seen(state, entry);
        }
    }
    let chain = conversation_chain(&entries);
    let mut events = Vec::new();
    // uuid 由 ingest 在发出之后记入 `seen`。这里先插入会让 skip_seen 把整段历史丢掉。
    for entry in chain {
        // 回合进行中写进去、被并进当前回合的消息不单独成一条 user 记录，只记成 `queued_command` 附件。
        if let Some(prompt) = absorbed_prompt(&entry) {
            events.push(user_event(prompt));
            continue;
        }
        if !is_visible_message(&entry) {
            continue;
        }
        let kind = entry.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "user" {
            let text = message_text(entry.get("message").unwrap_or(&Value::Null));
            if !text.trim().is_empty() && !content_has_tool_result(entry.get("message").unwrap_or(&Value::Null)) {
                let turn = entry.get("uuid").and_then(Value::as_str).unwrap_or("history");
                state.begin_turn(turn);
            }
        }
        let ingested = ingest_value(state, &entry, false, project);
        events.extend(ingested.events);
    }
    events
}

fn absorbed_prompt(entry: &Value) -> Option<String> {
    if entry.get("type").and_then(Value::as_str) != Some("attachment") || flag(entry, "isSidechain") {
        return None;
    }
    let attachment = entry.get("attachment")?;
    if attachment.get("type").and_then(Value::as_str) != Some("queued_command") {
        return None;
    }
    let prompt = attachment.get("prompt").and_then(Value::as_str)?.trim();
    (!prompt.is_empty()).then(|| prompt.to_string())
}

pub fn permission_events(request_id: &str, request: &Value) -> Option<(Vec<SessionEventBody>, PermissionKind)> {
    if request.get("subtype").and_then(Value::as_str) != Some("can_use_tool") {
        return None;
    }
    let tool_name = request.get("tool_name").and_then(Value::as_str).unwrap_or("tool");
    let input = request.get("input").cloned().unwrap_or(Value::Null);
    let summary = tool_summary(tool_name, &input);
    if tool_name == "AskUserQuestion" {
        let questions = control::questions_from_input(&input);
        if questions.is_empty() {
            return None;
        }
        let question = questions
            .first()
            .map(|item| item.question.clone())
            .unwrap_or_else(|| "需要回答问题".into());
        let events = vec![SessionEventBody::Prompt {
            prompt_id: request_id.to_string(),
            prompt_kind: PromptKind::Questions,
            question,
            options: Vec::new(),
            questions,
            header: String::new(),
            subtitle: String::new(),
            body: String::new(),
            body_kind: String::new(),
            reason: String::new(),
        }];
        let kind = PermissionKind::Questions {
            input,
            questions: match &events[0] {
                SessionEventBody::Prompt { questions, .. } => questions.clone(),
                _ => Vec::new(),
            },
        };
        return Some((events, kind));
    }
    if tool_name == "ExitPlanMode" {
        let plan = input.get("plan").and_then(Value::as_str).unwrap_or("").to_string();
        let mut events = Vec::new();
        if !plan.trim().is_empty() {
            events.push(SessionEventBody::PlanText {
                text: plan,
                stream_id: Some(format!("plan-{request_id}")),
                mode: Some("plan".into()),
            });
        }
        events.push(SessionEventBody::Prompt {
            prompt_id: request_id.to_string(),
            prompt_kind: PromptKind::Approval,
            question: "退出计划模式？".into(),
            options: control::approval_options(),
            questions: Vec::new(),
            header: String::new(),
            subtitle: String::new(),
            body: String::new(),
            body_kind: String::new(),
            reason: String::new(),
        });
        return Some((events, PermissionKind::ExitPlan { input }));
    }
    let (header, question, body, body_kind) = claude_approval_copy(tool_name, &summary);
    let events = vec![SessionEventBody::Prompt {
        prompt_id: request_id.to_string(),
        prompt_kind: PromptKind::Approval,
        question,
        options: control::approval_options(),
        questions: Vec::new(),
        header,
        subtitle: String::new(),
        body,
        body_kind,
        reason: String::new(),
    }];
    Some((events, PermissionKind::Approval { input }))
}

fn on_stream(state: &mut MapState, event: &Value, project: Option<&Path>) -> Vec<SessionEventBody> {
    let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "content_block_start" => {
            let index = event.get("index").and_then(Value::as_i64).unwrap_or(0);
            let block = event.get("content_block").unwrap_or(&Value::Null);
            let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
            let partial = match block_type {
                "thinking" => PartialBlock::Thinking,
                "tool_use" => PartialBlock::Tool {
                    id: block.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                    name: block.get("name").and_then(Value::as_str).unwrap_or("tool").to_string(),
                    json: String::new(),
                },
                _ => PartialBlock::Text,
            };
            state.partials.insert(index, partial);
            Vec::new()
        }
        "content_block_delta" => {
            let index = event.get("index").and_then(Value::as_i64).unwrap_or(0);
            let delta = event.get("delta").unwrap_or(&Value::Null);
            let delta_type = delta.get("type").and_then(Value::as_str).unwrap_or("");
            match delta_type {
                "text_delta" => {
                    let piece = delta.get("text").and_then(Value::as_str).unwrap_or("");
                    if state.text_stream_id.is_empty() {
                        state.text.clear();
                    }
                    state.text.push_str(piece);
                    text_event(state, MessagePhase::PartialAnswer, None)
                }
                "thinking_delta" => {
                    let piece = delta
                        .get("thinking")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if state.thinking_stream_id.is_empty() {
                        state.thinking.clear();
                    }
                    state.thinking.push_str(piece);
                    thinking_event(state, false, None)
                }
                "input_json_delta" => {
                    if let Some(PartialBlock::Tool { json, .. }) = state.partials.get_mut(&index) {
                        if let Some(piece) = delta.get("partial_json").and_then(Value::as_str) {
                            json.push_str(piece);
                        }
                    }
                    Vec::new()
                }
                _ => Vec::new(),
            }
        }
        "content_block_stop" => {
            let index = event.get("index").and_then(Value::as_i64).unwrap_or(0);
            let Some(partial) = state.partials.remove(&index) else {
                return Vec::new();
            };
            let PartialBlock::Tool { id, name, json } = partial else {
                return Vec::new();
            };
            let input = serde_json::from_str::<Value>(&json).unwrap_or(Value::Null);
            tool_events(state, &id, &name, &input, "", None, ToolStatus::Running, project)
        }
        _ => Vec::new(),
    }
}

fn on_system(state: &mut MapState, value: &Value, live: bool) -> Vec<SessionEventBody> {
    let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
    if subtype == "init" {
        // 历史里的 init 不能盖掉这次进程已经报告的模型。
        if live || state.model.is_none() {
            if let Some(model) = value.get("model").and_then(Value::as_str).filter(|item| !item.is_empty()) {
                state.model = Some(model.to_string());
            }
        }
        return Vec::new();
    }
    // 官方 stream-json 的重试是 `system/api_retry`（`error` 常为类别 `"unknown"`）。
    // 转录里同一件事是 `system/api_error`，带 `retryAttempt`。都还在重试，不是终态。
    if retry_notice(subtype, value) {
        return retry_note(state, value);
    }
    if subtype.starts_with("task_") {
        return subagents::on_task(state, subtype, value);
    }
    if subtype == "error" || subtype == "api_error" || value.get("error").is_some() {
        if quiet_user_stop(state.stop_requested, value) {
            return Vec::new();
        }
        if let Some(message) = useful_error_text(value) {
            return vec![SessionEventBody::Error { message }];
        }
        // 占位词滤掉后没有正文。直播里先不打红条，等 result 或进程退出再定。
        if live {
            return opaque_live_note(state, value);
        }
        return Vec::new();
    }
    Vec::new()
}

fn retry_notice(subtype: &str, value: &Value) -> bool {
    subtype == "api_retry" || (matches!(subtype, "api_error" | "error") && retry_in_progress(value))
}

/// 重试连发只留第一条。有 `formatted` / `message` / `connection` 就用原文，否则按类别写。
fn retry_note(state: &mut MapState, value: &Value) -> Vec<SessionEventBody> {
    let attempt = retry_attempt(value).unwrap_or(1);
    if attempt != 1 {
        return Vec::new();
    }
    state.connection_noted = true;
    let detail = useful_error_text(value)
        .or_else(|| opaque_label(value).map(str::to_string))
        .unwrap_or_else(|| "Claude Code 连接中断".to_string());
    vec![SessionEventBody::System {
        text: format!("{detail}，正在重试"),
    }]
}

fn opaque_live_note(state: &mut MapState, value: &Value) -> Vec<SessionEventBody> {
    if state.connection_noted {
        return Vec::new();
    }
    let Some(text) = opaque_label(value) else {
        return Vec::new();
    };
    state.connection_noted = true;
    vec![SessionEventBody::System { text: text.to_string() }]
}

/// 占位错误的灰提示。认得出类别或状态码就用对应句子，否则当成连接中断。
fn opaque_label(value: &Value) -> Option<&'static str> {
    if let Some(text) = classified_copy(value) {
        return Some(text);
    }
    if payload_is_opaque(value) {
        return Some("Claude Code 连接中断");
    }
    None
}

/// CLI 2.1.301 的 stream-json 常把错误对象收成字符串 `"unknown"`。
/// 转录里同一条是 `{formatted, message, connection}`。两种都读，不把占位词直接画出来。
/// 终态失败才用这份文案打红条；直播里的占位错误走灰提示。
fn system_error_text(value: &Value) -> String {
    if let Some(text) = useful_error_text(value) {
        return text;
    }
    if let Some(text) = errors_list_text(value) {
        return text;
    }
    if let Some(text) = classified_copy(value) {
        return text.to_string();
    }
    if payload_is_opaque(value) {
        return "Claude Code 连接中断".into();
    }
    let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
    if subtype == "api_error" || subtype == "api_retry" {
        "Claude Code 连接中断".into()
    } else {
        "Claude Code 报错".into()
    }
}

fn useful_error_text(value: &Value) -> Option<String> {
    if let Some(error) = value.get("error") {
        if let Some(text) = error_payload_text(error) {
            if !error_category_token(&text.to_ascii_lowercase()) {
                return Some(text);
            }
        }
    }
    if let Some(text) = text_field_filtered(value, "message") {
        if !error_category_token(&text.to_ascii_lowercase()) {
            return Some(text);
        }
    }
    let reason = value.get("terminal_reason").and_then(Value::as_str).unwrap_or("");
    reason_text(reason).map(str::to_string)
}

fn error_payload_text(error: &Value) -> Option<String> {
    match error {
        Value::String(text) => text_if_useful(text),
        Value::Object(_) => text_field_filtered(error, "formatted")
            .or_else(|| text_field_filtered(error, "message"))
            .or_else(|| {
                error
                    .pointer("/connection/message")
                    .and_then(Value::as_str)
                    .and_then(text_if_useful)
            }),
        _ => None,
    }
}

fn text_field_filtered(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).and_then(text_if_useful)
}

fn text_if_useful(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() || placeholder_error(trimmed) {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn placeholder_error(text: &str) -> bool {
    let folded = text.trim().to_ascii_lowercase();
    folded == "unknown" || folded == "unknown error"
}

fn reason_text(reason: &str) -> Option<&'static str> {
    match reason {
        "aborted_streaming" => Some("Claude Code 连接中断"),
        "aborted_tools" => Some("Claude Code 工具调用已中断"),
        "structured_output_retry_exhausted" => Some("Claude Code 输出重试已用尽"),
        "tool_deferred_unavailable" => Some("Claude Code 工具暂不可用"),
        "turn_setup_failed" => Some("Claude Code 没能开始这一轮"),
        _ => None,
    }
}

fn payload_is_opaque(value: &Value) -> bool {
    match value.get("error") {
        Some(error) => error_payload_text(error).is_none(),
        None => false,
    }
}

fn errors_list_text(value: &Value) -> Option<String> {
    let list = value.get("errors")?.as_array()?;
    let text = list
        .iter()
        .filter_map(|item| item.as_str().and_then(text_if_useful).or_else(|| text_field_filtered(item, "message")))
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() { None } else { Some(text) }
}

fn classified_copy(value: &Value) -> Option<&'static str> {
    let category = error_category(value).to_ascii_lowercase();
    if category != "unknown" && category != "unknown error" {
        if let Some(text) = category_copy(&category) {
            return Some(text);
        }
    }
    if let Some(text) = status_copy(http_status(value)) {
        return Some(text);
    }
    if category == "unknown" || category == "unknown error" {
        return Some("Claude Code 连接中断");
    }
    None
}

fn error_category(value: &Value) -> &str {
    value
        .get("error")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| error_category_token(&text.to_ascii_lowercase()) || placeholder_error(text))
        .unwrap_or("")
}

fn category_copy(category: &str) -> Option<&'static str> {
    match category {
        "rate_limit" => Some("Claude Code 请求过于频繁"),
        "overloaded" => Some("Claude Code 服务繁忙"),
        "server_error" => Some("Claude Code 连接中断"),
        "authentication_failed" | "oauth_org_not_allowed" => Some("Claude Code 登录失败"),
        "billing_error" | "account_on_hold" => Some("Claude Code 账户额度不足"),
        "invalid_request" => Some("Claude Code 请求无效"),
        "model_not_found" => Some("Claude Code 找不到模型"),
        "max_output_tokens" => Some("Claude Code 输出达到上限"),
        "cloud_credential_error" => Some("Claude Code 云凭证无效"),
        _ => None,
    }
}

fn error_category_token(folded: &str) -> bool {
    matches!(
        folded,
        "authentication_failed"
            | "oauth_org_not_allowed"
            | "account_on_hold"
            | "billing_error"
            | "rate_limit"
            | "overloaded"
            | "invalid_request"
            | "model_not_found"
            | "server_error"
            | "max_output_tokens"
            | "cloud_credential_error"
            | "unknown"
            | "unknown error"
    )
}

fn status_copy(status: Option<i64>) -> Option<&'static str> {
    match status {
        Some(429) => Some("Claude Code 请求过于频繁"),
        Some(529) => Some("Claude Code 服务繁忙"),
        Some(code) if (500..600).contains(&code) => Some("Claude Code 连接中断"),
        _ => None,
    }
}

fn http_status(value: &Value) -> Option<i64> {
    json_i64(value, "error_status")
        .or_else(|| json_i64(value, "api_error_status"))
        .or_else(|| value.pointer("/error/status").and_then(Value::as_i64))
}

fn retry_in_progress(value: &Value) -> bool {
    match (retry_attempt(value), retry_limit(value)) {
        (Some(attempt), Some(max)) => attempt < max,
        _ => false,
    }
}

fn retry_attempt(value: &Value) -> Option<i64> {
    json_i64(value, "retryAttempt").or_else(|| json_i64(value, "attempt"))
}

fn retry_limit(value: &Value) -> Option<i64> {
    json_i64(value, "maxRetries").or_else(|| json_i64(value, "max_retries"))
}

fn on_assistant(state: &mut MapState, value: &Value, project: Option<&Path>, live: bool) -> Vec<SessionEventBody> {
    if skip_seen(state, value) || flag(value, "isMeta") {
        return Vec::new();
    }
    // 旁路不进主时间线，挂到它的子 Agent 下面。实时用量仍按 message.id 记，历史由 jsonl 快照覆盖。
    if sidechain(value) {
        if !live {
            return Vec::new();
        }
        let mut events = subagents::live_step(state, value, project);
        events.extend(super::usage::apply_assistant(&mut state.usage, value));
        return events;
    }
    assistant_body(state, value, project, live)
}

/// 一条助手消息的正文、思考和工具。子 Agent 用它自己的状态走同一条路。
pub(super) fn assistant_body(
    state: &mut MapState,
    value: &Value,
    project: Option<&Path>,
    live: bool,
) -> Vec<SessionEventBody> {
    let message = value.get("message").unwrap_or(&Value::Null);
    let content = message.get("content").unwrap_or(&Value::Null);
    let mut events = Vec::new();
    let mut text = String::new();
    let mut thinking = String::new();
    if let Some(blocks) = content.as_array() {
        for block in blocks {
            let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
            match block_type {
                "text" => text.push_str(block.get("text").and_then(Value::as_str).unwrap_or("")),
                "thinking" => thinking.push_str(block.get("thinking").and_then(Value::as_str).unwrap_or("")),
                "tool_use" => {
                    let id = block.get("id").and_then(Value::as_str).unwrap_or("");
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let input = block.get("input").cloned().unwrap_or(Value::Null);
                    events.extend(tool_events(state, id, name, &input, "", None, ToolStatus::Running, project));
                }
                _ => {}
            }
        }
    } else if let Some(plain) = content.as_str() {
        text.push_str(plain);
    }
    let anchor = message_anchor(value);
    let api_error = flag(value, "isApiErrorMessage") || flag(message, "isApiErrorMessage");
    if !text.is_empty() && (api_error || connection_lost_text(&text)) {
        // 接口错误不是模型答复。流式碎片若已经写成这句英文，用同一 stream 清掉。
        events.extend(retract_streamed_api_error(state, &text));
        events.extend(api_error_notice(state, value, &text));
    } else if !text.is_empty() {
        state.text = text;
        events.extend(text_event(state, MessagePhase::FinalAnswer, anchor));
    }
    if !thinking.is_empty() {
        state.thinking = thinking;
        events.extend(thinking_event(state, true, anchor));
    }
    if live {
        if let Some(body) = super::usage::apply_assistant(&mut state.usage, value) {
            events.push(body);
        }
    }
    events
}

fn on_user(state: &mut MapState, value: &Value, live: bool, project: Option<&Path>) -> Vec<SessionEventBody> {
    if skip_seen(state, value) || flag(value, "isMeta") {
        return Vec::new();
    }
    if sidechain(value) {
        return if live { subagents::live_step(state, value, project) } else { Vec::new() };
    }
    if let Some(events) = subagents::notification_message(state, value) {
        return events;
    }
    user_body(state, value, live, project)
}

/// 一条用户消息里的工具结果和正文。
pub(super) fn user_body(state: &mut MapState, value: &Value, live: bool, project: Option<&Path>) -> Vec<SessionEventBody> {
    let message = value.get("message").unwrap_or(&Value::Null);
    let content = message.get("content").unwrap_or(&Value::Null);
    // 直播是 `tool_use_result`，会话记录里是 `toolUseResult`。
    let structured = value.get("tool_use_result").or_else(|| value.get("toolUseResult"));
    let mut events = Vec::new();
    if let Some(blocks) = content.as_array() {
        let mut text = String::new();
        for block in blocks {
            let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
            if block_type == "tool_result" {
                events.extend(on_tool_result(state, block, structured, project));
            } else if block_type == "text" {
                text.push_str(block.get("text").and_then(Value::as_str).unwrap_or(""));
            }
        }
        if !live && !text.trim().is_empty() {
            events.insert(0, user_event(text));
        }
        return events;
    }
    if live {
        return events;
    }
    if let Some(text) = content.as_str() {
        if !text.trim().is_empty() {
            events.push(user_event(text.to_string()));
        }
    }
    events
}

fn on_tool_result(
    state: &mut MapState,
    block: &Value,
    structured: Option<&Value>,
    project: Option<&Path>,
) -> Vec<SessionEventBody> {
    let id = block.get("tool_use_id").and_then(Value::as_str).unwrap_or("");
    let detail = tool_result_text(block);
    let Some(row) = state.tools.get(id) else {
        return Vec::new();
    };
    let reported = row.reported.clone();
    let input = row.input.clone();
    if subagents::is_agent_tool(&reported) {
        return subagents::returned(state, id, block, structured, &detail);
    }
    let status = if block.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
        ToolStatus::Failed
    } else {
        ToolStatus::Completed
    };
    tool_events(state, id, &reported, &input, &detail, structured, status, project)
}

fn on_result(state: &mut MapState, value: &Value, live: bool) -> Vec<SessionEventBody> {
    let mut events = Vec::new();
    if state.text.trim().is_empty() {
        if let Some(result) = value.get("result").and_then(Value::as_str) {
            // 断线句子留在 result 里时，不要再写成最终答复。
            if !result.trim().is_empty() && !connection_lost_text(result) {
                state.text = result.to_string();
                events.extend(text_event(state, MessagePhase::FinalAnswer, None));
            }
        }
    }
    if let Some(usage) = value.get("usage") {
        let input_tokens = json_i64(usage, "input_tokens");
        let output_tokens = json_i64(usage, "output_tokens");
        if input_tokens.is_some() || output_tokens.is_some() {
            events.push(SessionEventBody::ContextUsage {
                source: "partial-usage".into(),
                used_tokens: None,
                max_tokens: None,
                percentage: None,
                input_tokens,
                output_tokens,
                model: state.model.clone(),
            });
        }
    }
    // result.usage 是本轮各次 API 调用的再加总，和 assistant 记录重复。不记入会话用量。
    // 打开会话时的状态由 runtime 在历史装完后写。历史 result 不改当前状态。
    if live {
        let status = result_status(value);
        if status != SessionStatus::Stopped
            && !quiet_user_stop(state.stop_requested, value)
            && !state.turn_failure_noted
        {
            if let Some(message) = turn_failure_message(value) {
                state.turn_failure_noted = true;
                events.push(SessionEventBody::Error { message });
            }
        }
        // 停止只盖住这一轮的结果。后面的断线仍要报。
        state.stop_requested = false;
        events.push(SessionEventBody::StatusChanged { status });
    }
    events
}

pub fn result_status(value: &Value) -> SessionStatus {
    let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
    let reason = value.get("terminal_reason").and_then(Value::as_str).unwrap_or("");
    if user_stopped_turn(subtype, reason) {
        SessionStatus::Stopped
    } else {
        // 连接中断、工具中断、这一轮 is_error：进程还在，作曲栏要能继续发。
        // 进程自己退出仍由 runtime::on_eof 标成 Failed。
        SessionStatus::Completed
    }
}

fn user_stopped_turn(subtype: &str, reason: &str) -> bool {
    if reason == "aborted_user" || subtype.contains("interrupt") {
        return true;
    }
    // CLI 2.1.301 起，断线和用户按下停止都报 aborted_streaming / aborted_tools。
    // 这里不能当成用户停止：Stopped 会把作曲栏锁成「请新建会话」。
    // 按下停止记在 stop_requested 上，只消掉红条，状态仍是 Completed。
    if reason_text(reason).is_some() || reason == "aborted_by_mock" {
        return false;
    }
    subtype.contains("abort") || reason.starts_with("aborted_")
}

/// 用户按下停止后，流中止和占位断线不画红条。具体的接口错误仍然画。
fn quiet_user_stop(stop_requested: bool, value: &Value) -> bool {
    if !stop_requested {
        return false;
    }
    let reason = value.get("terminal_reason").and_then(Value::as_str).unwrap_or("");
    if user_interrupt_reason(reason) {
        return true;
    }
    opaque_disconnect(value)
}

fn user_interrupt_reason(reason: &str) -> bool {
    reason.starts_with("aborted_")
}

fn opaque_disconnect(value: &Value) -> bool {
    if specific_error_text(value).is_some() {
        return false;
    }
    let category = error_category(value);
    category == "unknown" || category == "unknown error" || payload_is_opaque(value)
}

fn specific_error_text(value: &Value) -> Option<String> {
    if let Some(error) = value.get("error") {
        if let Some(text) = error_payload_text(error) {
            if !error_category_token(&text.to_ascii_lowercase()) {
                return Some(text);
            }
        }
    }
    if let Some(text) = text_field_filtered(value, "message") {
        if !error_category_token(&text.to_ascii_lowercase()) {
            return Some(text);
        }
    }
    errors_list_text(value)
}

fn turn_failure_message(value: &Value) -> Option<String> {
    let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
    let reason = value.get("terminal_reason").and_then(Value::as_str).unwrap_or("");
    let is_error = value.get("is_error").and_then(Value::as_bool).unwrap_or(false);
    if user_stopped_turn(subtype, reason) {
        return None;
    }
    let failed = is_error || subtype.starts_with("error") || reason_text(reason).is_some();
    if !failed {
        return None;
    }
    if value
        .get("result")
        .and_then(Value::as_str)
        .is_some_and(connection_lost_text)
    {
        return Some("Claude Code 连接中断".into());
    }
    Some(system_error_text(value))
}

/// `claude.exe` 在 `truncatedAfterOutput` 时写入的断线句子。
fn connection_lost_text(text: &str) -> bool {
    text.trim()
        .to_ascii_lowercase()
        .contains("connection lost mid-response")
}

/// 流式增量已经把这句英文写进当前气泡时，用空正文盖掉，避免留在答复里。
fn retract_streamed_api_error(state: &mut MapState, api_text: &str) -> Vec<SessionEventBody> {
    if !stream_is_this_error(state, api_text) {
        return Vec::new();
    }
    let stream_id = state.text_stream_id.clone();
    state.text_stream_id.clear();
    state.text.clear();
    vec![SessionEventBody::AgentMessage {
        text: String::new(),
        stream_id: Some(stream_id),
        phase: Some(MessagePhase::Commentary),
        mode: None,
        dedupe_of: None,
    }]
}

fn stream_is_this_error(state: &MapState, api_text: &str) -> bool {
    if state.text_stream_id.is_empty() {
        return false;
    }
    let current = state.text.trim();
    let api = api_text.trim();
    if current.is_empty() {
        return false;
    }
    current == api || api.starts_with(current) || connection_lost_text(current)
}

/// 助手信封上的 `isApiErrorMessage`。`error=server_error` 走已有的「连接中断」。
fn api_error_notice(state: &mut MapState, value: &Value, text: &str) -> Vec<SessionEventBody> {
    if state.turn_failure_noted {
        return Vec::new();
    }
    state.turn_failure_noted = true;
    let message = classified_copy(value).map(str::to_string).unwrap_or_else(|| {
        if connection_lost_text(text) {
            "Claude Code 连接中断".to_string()
        } else {
            "Claude Code 报错".to_string()
        }
    });
    vec![SessionEventBody::Error { message }]
}

fn on_goal(value: &Value) -> Vec<SessionEventBody> {
    let goal = match value.get("value") {
        Some(Value::Null) | None => SessionEventBody::Goal {
            objective: None,
            status: None,
            token_budget: None,
            tokens_used: None,
            time_used_seconds: None,
        },
        Some(body) => {
            let condition = body.get("condition").and_then(Value::as_str).unwrap_or("").trim().to_string();
            if condition.is_empty() {
                SessionEventBody::Goal {
                    objective: None,
                    status: None,
                    token_budget: None,
                    tokens_used: None,
                    time_used_seconds: None,
                }
            } else {
                SessionEventBody::Goal {
                    objective: Some(condition),
                    status: Some("active".into()),
                    token_budget: None,
                    tokens_used: None,
                    time_used_seconds: None,
                }
            }
        }
    };
    vec![goal]
}

fn tool_events(
    state: &mut MapState,
    id: &str,
    reported: &str,
    input: &Value,
    detail: &str,
    // 工具结果的结构化部分，带 `originalFile`。
    structured: Option<&Value>,
    // `tool_use` 时进行中，`tool_result` 时按 `is_error` 分成功或失败。
    // 只有成功跑完的工具才算进这一轮的变更；被拒绝、被打断或还在等审批的不算。
    status: ToolStatus,
    project: Option<&Path>,
) -> Vec<SessionEventBody> {
    if id.is_empty() {
        return Vec::new();
    }
    state.tools.insert(
        id.to_string(),
        ToolRow {
            reported: reported.to_string(),
            input: input.clone(),
        },
    );
    if subagents::is_agent_tool(reported) {
        return subagents::spawned(state, id, input);
    }
    let summary = tool_summary(reported, input);
    let mut events = vec![SessionEventBody::ToolCall {
        name: display_tool_name(reported),
        summary,
        detail: detail.to_string(),
        stream_id: Some(id.to_string()),
        images: Vec::new(),
        status,
        exit_code: None,
    }];
    if state.turn_id.is_empty() || status != ToolStatus::Completed {
        return events;
    }
    let result = result_value(detail);
    let changes = diff::changes_for_tool(project, reported, input, result.as_ref());
    if changes.is_empty() {
        return events;
    }
    let total = state.baselines.turn_change(reported, input, structured);
    for change in &changes {
        match &total {
            Some(total) if same_target(total, change) => upsert_total(&mut state.files, total.clone()),
            _ => upsert_file(&mut state.files, change.clone()),
        }
        events.push(SessionEventBody::FileChange {
            turn_id: state.turn_id.clone(),
            path: change.path.clone(),
            status: change.status,
            added: change.added,
            removed: change.removed,
            diff: change.diff.clone(),
        });
    }
    state.turn_diff = state
        .files
        .iter()
        .map(|file| file.diff.clone())
        .collect::<Vec<_>>()
        .join("\n");
    events.push(SessionEventBody::TurnDiff {
        turn_id: state.turn_id.clone(),
        diff: state.turn_diff.clone(),
    });
    events.push(SessionEventBody::TurnChanges {
        turn_id: state.turn_id.clone(),
        files: state.files.clone(),
    });
    events
}

fn result_value(detail: &str) -> Option<Value> {
    if detail.trim().is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(detail).ok().or_else(|| {
        if detail.trim_start().starts_with("diff ")
            || detail.trim_start().starts_with("--- ")
            || detail.contains("structuredPatch")
        {
            Some(Value::String(detail.to_string()))
        } else {
            None
        }
    })
}

/// 没有原文可比时，用这次工具调用自己的 diff。
fn upsert_file(files: &mut Vec<FileChange>, change: FileChange) {
    if let Some(existing) = files.iter_mut().find(|file| file.path == change.path) {
        *existing = change;
    } else {
        files.push(change);
    }
}

/// 拿这一轮原文比出来的累计变更。改回原样的文件不再列。
fn upsert_total(files: &mut Vec<FileChange>, total: FileChange) {
    if total.added == 0 && total.removed == 0 {
        files.retain(|file| file.path != total.path);
    } else {
        upsert_file(files, total);
    }
}

fn same_target(total: &FileChange, change: &FileChange) -> bool {
    crate::changes::same_file(&total.path, &change.path)
}

fn text_event(state: &mut MapState, phase: MessagePhase, message_id: Option<&str>) -> Vec<SessionEventBody> {
    if state.text.is_empty() {
        return Vec::new();
    }
    if state.text_stream_id.is_empty() {
        state.text_stream_id = next_stream_id(state, "assistant", message_id);
    }
    let stream_id = state.text_stream_id.clone();
    if phase == MessagePhase::FinalAnswer {
        state.text_stream_id.clear();
    }
    vec![SessionEventBody::AgentMessage {
        text: state.text.clone(),
        stream_id: Some(stream_id),
        phase: Some(phase),
        mode: None,
        dedupe_of: None,
    }]
}

fn thinking_event(state: &mut MapState, finalize: bool, message_id: Option<&str>) -> Vec<SessionEventBody> {
    if state.thinking.is_empty() {
        return Vec::new();
    }
    if state.thinking_stream_id.is_empty() {
        state.thinking_stream_id = next_stream_id(state, "thinking", message_id);
    }
    let stream_id = state.thinking_stream_id.clone();
    if finalize {
        state.thinking_stream_id.clear();
    }
    vec![SessionEventBody::Thinking {
        text: state.thinking.clone(),
        stream_id: Some(stream_id),
    }]
}

/// 会话日志用 `stream_id` 在整段会话里找旧气泡。固定的 `"assistant"` 会让后一轮盖掉前一轮。
fn next_stream_id(state: &mut MapState, kind: &str, message_id: Option<&str>) -> String {
    if let Some(id) = message_id.map(str::trim).filter(|id| !id.is_empty()) {
        return format!("{kind}:{id}");
    }
    state.stream_nonce = state.stream_nonce.saturating_add(1);
    if state.turn_id.is_empty() {
        format!("{kind}:{}", state.stream_nonce)
    } else {
        format!("{kind}:{}:{}", state.turn_id, state.stream_nonce)
    }
}

fn message_anchor(value: &Value) -> Option<&str> {
    let uuid = value.get("uuid").and_then(Value::as_str).map(str::trim).filter(|id| !id.is_empty());
    if uuid.is_some() {
        return uuid;
    }
    value
        .get("message")
        .and_then(|message| message.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
}

fn user_event(text: String) -> SessionEventBody {
    SessionEventBody::UserMessage {
        text: slash_command_text(&text).unwrap_or(text),
        images: Vec::new(),
        annotations: 0,
        sender: None,
    }
}

/// 转录把斜杠命令记成 `<command-name>/goal</command-name>…<command-args>…</command-args>`。
/// 时间线里照用户输入的样子写回 `/goal …`。
fn slash_command_text(text: &str) -> Option<String> {
    let tag = |name: &str| {
        let open = format!("<{name}>");
        let close = format!("</{name}>");
        let start = text.find(&open)? + open.len();
        let end = start + text[start..].find(&close)?;
        Some(text[start..end].trim().to_string())
    };
    let name = tag("command-name").filter(|name| name.starts_with('/'))?;
    let args = tag("command-args").unwrap_or_default();
    Some(if args.is_empty() { name } else { format!("{name} {args}") })
}

pub fn display_tool_name(reported: &str) -> String {
    match reported {
        "Bash" | "PowerShell" => "command".into(),
        other => other.to_string(),
    }
}

fn claude_approval_copy(tool_name: &str, summary: &str) -> (String, String, String, String) {
    let header = display_tool_name(tool_name);
    let shown = summary.trim();
    let has_detail = !shown.is_empty() && shown != tool_name;
    let body_kind = match tool_name {
        "Bash" | "PowerShell" if has_detail => "command",
        "Edit" | "Write" | "NotebookEdit" | "MultiEdit" if has_detail => "files",
        _ => "",
    };
    let body = if body_kind.is_empty() {
        String::new()
    } else {
        shown.to_string()
    };
    let question = if has_detail && body_kind.is_empty() {
        format!("允许 {tool_name}：{shown}？")
    } else {
        format!("允许使用 {tool_name}？")
    };
    (header, question, body, body_kind.to_string())
}

fn tool_summary(reported: &str, input: &Value) -> String {
    match reported {
        "Bash" | "PowerShell" => input
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or(reported)
            .to_string(),
        "Edit" | "Write" | "NotebookEdit" | "MultiEdit" => input
            .get("file_path")
            .or_else(|| input.get("path"))
            .and_then(Value::as_str)
            .unwrap_or(reported)
            .to_string(),
        _ => reported.to_string(),
    }
}

fn tool_result_text(block: &Value) -> String {
    let content = block.get("content").unwrap_or(&Value::Null);
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if let Some(blocks) = content.as_array() {
        return blocks
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
    }
    if content.is_null() {
        return String::new();
    }
    content.to_string()
}

fn message_text(message: &Value) -> String {
    let content = message.get("content").unwrap_or(&Value::Null);
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    content
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| {
                    if block.get("type").and_then(Value::as_str) == Some("text") {
                        block.get("text").and_then(Value::as_str)
                    } else {
                        None
                    }
                })
                .collect::<String>()
        })
        .unwrap_or_default()
}

fn content_has_tool_result(message: &Value) -> bool {
    message
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
        })
        .unwrap_or(false)
}

fn skip_seen(state: &mut MapState, value: &Value) -> bool {
    let Some(uuid) = value.get("uuid").and_then(Value::as_str) else {
        return false;
    };
    if state.seen.contains(uuid) {
        return true;
    }
    state.seen.insert(uuid.to_string());
    false
}

/// 子 Agent 的消息。转录里标 `isSidechain`；实时流不带它，只带派它的那次工具调用的 `parent_tool_use_id`。
/// 照 t3code `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` 按 `parent_tool_use_id` 区分主线。
fn sidechain(value: &Value) -> bool {
    flag(value, "isSidechain")
        || value
            .get("parent_tool_use_id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn json_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

pub fn context_usage_from_response(payload: &Value, fallback_model: Option<String>) -> Option<SessionEventBody> {
    let used_tokens = json_i64(payload, "totalTokens");
    let max_tokens = json_i64(payload, "maxTokens");
    let percentage = payload.get("percentage").and_then(Value::as_f64);
    let model = payload
        .get("model")
        .and_then(Value::as_str)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .or(fallback_model);
    if used_tokens.is_none() && max_tokens.is_none() && percentage.is_none() && model.is_none() {
        return None;
    }
    Some(SessionEventBody::ContextUsage {
        source: "get_context_usage".into(),
        used_tokens,
        max_tokens,
        percentage,
        input_tokens: None,
        output_tokens: None,
        model,
    })
}
