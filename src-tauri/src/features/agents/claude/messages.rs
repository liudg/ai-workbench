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
use std::path::Path;

use serde_json::Value;

use super::control::{self, PermissionKind};
use super::diff;
use super::history::{conversation_chain, is_visible_message, transcript_entries};
use crate::models::{
    FileChange, MessagePhase, PromptKind, SessionEventBody, SessionStatus,
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
    pub turn_diff: String,
    /// 上一轮非空 diff。`begin_turn` 会清掉当前轮，这里留下最近一次。
    saved_diff: String,
    pub model: Option<String>,
}

struct ToolRow {
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
        self.turn_diff.clear();
        self.text_stream_id.clear();
        self.thinking_stream_id.clear();
        self.turn_id = turn_id.to_string();
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
        "stream_event" => Ingest {
            events: on_stream(state, value.get("event").unwrap_or(&Value::Null), project),
            control: None,
        },
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
    for entry in chain.into_iter().filter(|entry| is_visible_message(entry)) {
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
        });
        return Some((events, PermissionKind::ExitPlan { input }));
    }
    let question = if summary.is_empty() {
        format!("允许使用 {tool_name}？")
    } else {
        format!("允许 {tool_name}：{summary}？")
    };
    let events = vec![SessionEventBody::Prompt {
        prompt_id: request_id.to_string(),
        prompt_kind: PromptKind::Approval,
        question,
        options: control::approval_options(),
        questions: Vec::new(),
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
            tool_events(state, &id, &name, &input, "", project)
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
    if subtype == "error" || value.get("error").is_some() {
        let message = value
            .get("error")
            .and_then(Value::as_str)
            .or_else(|| value.get("message").and_then(Value::as_str))
            .unwrap_or("Claude Code 报错");
        return vec![SessionEventBody::Error { message: message.to_string() }];
    }
    Vec::new()
}

fn on_assistant(state: &mut MapState, value: &Value, project: Option<&Path>, live: bool) -> Vec<SessionEventBody> {
    if skip_seen(state, value) || flag(value, "isMeta") {
        return Vec::new();
    }
    // 旁路不进时间线。实时用量仍要记，历史由 jsonl 快照覆盖。
    if flag(value, "isSidechain") {
        if !live {
            return Vec::new();
        }
        return super::usage::live_subagent(value).into_iter().collect();
    }
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
                    events.extend(tool_events(state, id, name, &input, "", project));
                }
                _ => {}
            }
        }
    } else if let Some(plain) = content.as_str() {
        text.push_str(plain);
    }
    let anchor = message_anchor(value);
    if !text.is_empty() {
        state.text = text;
        events.extend(text_event(state, MessagePhase::FinalAnswer, anchor));
    }
    if !thinking.is_empty() {
        state.thinking = thinking;
        events.extend(thinking_event(state, true, anchor));
    }
    if live {
        if let Some(body) = super::usage::live_subagent(value) {
            events.push(body);
        }
    }
    events
}

fn on_user(state: &mut MapState, value: &Value, live: bool, project: Option<&Path>) -> Vec<SessionEventBody> {
    if skip_seen(state, value) || flag(value, "isMeta") || flag(value, "isSidechain") {
        return Vec::new();
    }
    let message = value.get("message").unwrap_or(&Value::Null);
    let content = message.get("content").unwrap_or(&Value::Null);
    let mut events = Vec::new();
    if let Some(blocks) = content.as_array() {
        let mut text = String::new();
        for block in blocks {
            let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
            if block_type == "tool_result" {
                events.extend(on_tool_result(state, block, project));
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

fn on_tool_result(state: &mut MapState, block: &Value, project: Option<&Path>) -> Vec<SessionEventBody> {
    let id = block.get("tool_use_id").and_then(Value::as_str).unwrap_or("");
    let detail = tool_result_text(block);
    let Some(row) = state.tools.get(id) else {
        return Vec::new();
    };
    let reported = row.reported.clone();
    let input = row.input.clone();
    tool_events(state, id, &reported, &input, &detail, project)
}

fn on_result(state: &mut MapState, value: &Value, live: bool) -> Vec<SessionEventBody> {
    let mut events = Vec::new();
    if state.text.trim().is_empty() {
        if let Some(result) = value.get("result").and_then(Value::as_str) {
            if !result.trim().is_empty() {
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
    if live {
        if let Some(body) = super::usage::live_result(value) {
            events.push(body);
        }
    }
    // 打开会话时的状态由 runtime 在历史装完后写。历史 result 不改当前状态。
    if live {
        events.push(SessionEventBody::StatusChanged { status: result_status(value) });
    }
    events
}

pub fn result_status(value: &Value) -> SessionStatus {
    let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
    let reason = value.get("terminal_reason").and_then(Value::as_str).unwrap_or("");
    let is_error = value.get("is_error").and_then(Value::as_bool).unwrap_or(false);
    if reason.starts_with("aborted_") || subtype.contains("abort") {
        return SessionStatus::Stopped;
    }
    if is_error || subtype.starts_with("error") {
        return SessionStatus::Failed;
    }
    SessionStatus::Completed
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
    let summary = tool_summary(reported, input);
    let mut events = vec![SessionEventBody::ToolCall {
        name: display_tool_name(reported),
        summary,
        detail: detail.to_string(),
        stream_id: Some(id.to_string()),
        images: Vec::new(),
    }];
    if state.turn_id.is_empty() {
        return events;
    }
    let result = result_value(detail);
    let changes = diff::changes_for_tool(project, reported, input, result.as_ref());
    if changes.is_empty() {
        return events;
    }
    for change in &changes {
        upsert_file(&mut state.files, change.clone());
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

fn upsert_file(files: &mut Vec<FileChange>, change: FileChange) {
    if let Some(existing) = files.iter_mut().find(|file| file.path == change.path) {
        *existing = change;
    } else {
        files.push(change);
    }
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
        text,
        images: Vec::new(),
        annotations: 0,
    }
}

pub fn display_tool_name(reported: &str) -> String {
    match reported {
        "Bash" | "PowerShell" => "command".into(),
        other => other.to_string(),
    }
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
