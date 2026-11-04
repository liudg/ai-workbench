//! Claude 自带的子 Agent（`Agent` 工具，旧版叫 `Task`）→ 子 Agent 卡片和它自己的步骤。
//!
//! 卡片以派它的那次工具调用 id 为准：实时流里子 Agent 的消息带同一个 `parent_tool_use_id`，
//! `system/task_*` 事件带 `tool_use_id`（`task_updated` 只带 `task_id`，按 `task_started` 记下的对应关系找）。
//! 前台子 Agent 的结果在工具结果的 `tool_use_result` 里；后台的工具结果只是 `async_launched`，
//! 结束靠 `task_notification`，转录里是一条 `origin.kind = task-notification` 的用户消息。
//! 转录里子 Agent 自己的记录在 `<会话 id>/subagents/agent-<agentId>.jsonl`。
//! 实测 Claude Code 2.1.312（2026-11-04）。展示照 t3code
//! `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`。

use std::path::Path;

use serde_json::Value;

use aiwb_core::models::{SessionEventBody, SubagentCard, SubagentStatus};

use super::history::transcript_entries;
use super::messages::{assistant_body, user_body, MapState};

impl MapState {
    /// 进程退出时还在跑的子 Agent 记成已停止。
    pub(super) fn stop_subagents(&mut self) -> Vec<SessionEventBody> {
        let at = Some(aiwb_core::models::now_millis());
        self.subagents
            .values_mut()
            .filter(|card| card.status == SubagentStatus::Running)
            .map(|card| {
                card.finish(SubagentStatus::Stopped, at);
                SessionEventBody::Subagent(card.clone())
            })
            .collect()
    }
}

pub(super) fn is_agent_tool(reported: &str) -> bool {
    matches!(reported, "Agent" | "Task")
}

/// 派出子 Agent 的那次工具调用。流式收束和完整消息各来一次，只补字段。
pub(super) fn spawned(state: &mut MapState, id: &str, input: &Value) -> Vec<SessionEventBody> {
    let at = state.clock;
    let card = card_mut(state, id);
    if let Some(title) = text(input, "description") {
        card.title = title;
    }
    if let Some(kind) = text(input, "subagent_type") {
        card.agent_type = kind;
    }
    if let Some(prompt) = text(input, "prompt") {
        card.prompt = prompt;
    }
    if let Some(model) = text(input, "model") {
        card.model.get_or_insert(model);
    }
    if input.get("run_in_background").and_then(Value::as_bool) == Some(true) {
        card.background = true;
    }
    if card.started_at.is_none() {
        card.started_at = at;
    }
    vec![SessionEventBody::Subagent(card.clone())]
}

/// `Agent` 工具的结果。前台跑完带结果和用量；后台只说已启动。
pub(super) fn returned(
    state: &mut MapState,
    id: &str,
    block: &Value,
    structured: Option<&Value>,
    detail: &str,
) -> Vec<SessionEventBody> {
    let mut events = structured
        .and_then(|value| text(value, "agentId"))
        .map(|agent_id| replay_transcript(state, id, &agent_id))
        .unwrap_or_default();
    let at = state.clock;
    let card = card_mut(state, id);
    let failed = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
    let status = structured.and_then(|value| value.get("status")).and_then(Value::as_str);
    if let Some(value) = structured {
        if let Some(model) = text(value, "resolvedModel") {
            card.model = Some(model);
        }
        if let Some(prompt) = text(value, "prompt").filter(|_| card.prompt.is_empty()) {
            card.prompt = prompt;
        }
        if value.get("isAsync").and_then(Value::as_bool) == Some(true) {
            card.background = true;
        }
    }
    if failed {
        card.result = detail.trim().to_string();
        card.finish(SubagentStatus::Failed, at);
    } else if status == Some("async_launched") {
        card.background = true;
    } else {
        if let Some(value) = structured {
            let answer = report_text(value);
            if !answer.is_empty() {
                card.result = answer;
            }
            card.duration_ms = value.get("totalDurationMs").and_then(Value::as_i64).or(card.duration_ms);
            card.tokens = value.get("totalTokens").and_then(Value::as_i64).or(card.tokens);
            card.tool_uses = value.get("totalToolUseCount").and_then(Value::as_i64).or(card.tool_uses);
        } else if card.result.is_empty() {
            card.result = detail.trim().to_string();
        }
        card.finish(status.map(status_of).unwrap_or(SubagentStatus::Completed), at);
    }
    events.push(SessionEventBody::Subagent(card.clone()));
    events
}

/// `system/task_started` / `task_progress` / `task_updated` / `task_notification`。
/// 不是子 Agent 的后台任务（`local_bash` 等）不管。
pub(super) fn on_task(state: &mut MapState, subtype: &str, value: &Value) -> Vec<SessionEventBody> {
    let task_id = text(value, "task_id").unwrap_or_default();
    let tool_id = match text(value, "tool_use_id") {
        Some(id) if subtype == "task_started" => {
            if value.get("task_type").and_then(Value::as_str) != Some("local_agent") {
                return Vec::new();
            }
            state.subagent_tasks.insert(task_id.clone(), id.clone());
            id
        }
        _ => match state.subagent_tasks.get(&task_id) {
            Some(id) => id.clone(),
            None => return Vec::new(),
        },
    };
    let at = state.clock;
    let card = card_mut(state, &tool_id);
    match subtype {
        "task_started" => {
            if card.title.is_empty() {
                card.title = text(value, "description").unwrap_or_default();
            }
            if let Some(kind) = text(value, "subagent_type") {
                card.agent_type = kind;
            }
            if let Some(prompt) = text(value, "prompt").filter(|_| card.prompt.is_empty()) {
                card.prompt = prompt;
            }
            if value.get("is_backgrounded").and_then(Value::as_bool) == Some(true) {
                card.background = true;
            }
            if card.started_at.is_none() {
                card.started_at = at;
            }
        }
        "task_progress" => {
            if card.status != SubagentStatus::Running {
                return Vec::new();
            }
            card.activity = text(value, "description").unwrap_or_default();
            apply_usage(card, value.get("usage"));
        }
        "task_updated" => {
            let patch = value.get("patch").unwrap_or(&Value::Null);
            let Some(status) = patch.get("status").and_then(Value::as_str).map(status_of) else {
                return Vec::new();
            };
            if status == SubagentStatus::Running {
                return Vec::new();
            }
            card.finish(status, patch.get("end_time").and_then(Value::as_i64).or(at));
        }
        "task_notification" => {
            if let Some(summary) = text(value, "summary") {
                card.result = summary;
            }
            apply_usage(card, value.get("usage"));
            let status = value.get("status").and_then(Value::as_str).map(status_of);
            card.finish(status.unwrap_or(SubagentStatus::Completed), at);
        }
        _ => return Vec::new(),
    }
    vec![SessionEventBody::Subagent(card.clone())]
}

/// 转录里后台子 Agent 结束时补的那条用户消息。是的话改卡片，不画用户气泡。
pub(super) fn notification_message(state: &mut MapState, value: &Value) -> Option<Vec<SessionEventBody>> {
    if value.pointer("/origin/kind").and_then(Value::as_str) != Some("task-notification") {
        return None;
    }
    let content = value.pointer("/message/content").and_then(Value::as_str).unwrap_or("");
    let Some(tool_id) = tag(content, "tool-use-id") else {
        return Some(Vec::new());
    };
    let at = state.clock;
    let card = card_mut(state, &tool_id);
    if let Some(result) = tag(content, "result") {
        card.result = result;
    }
    card.tokens = tag(content, "subagent_tokens").and_then(|n| n.parse().ok()).or(card.tokens);
    card.tool_uses = tag(content, "tool_uses").and_then(|n| n.parse().ok()).or(card.tool_uses);
    card.duration_ms = tag(content, "duration_ms").and_then(|n| n.parse().ok()).or(card.duration_ms);
    let status = tag(content, "status").map(|status| status_of(&status));
    card.finish(status.unwrap_or(SubagentStatus::Completed), at);
    Some(vec![SessionEventBody::Subagent(card.clone())])
}

/// 实时流里带 `parent_tool_use_id` 的消息：按子 Agent 自己的状态映射，只留回答、思考和工具。
pub(super) fn live_step(state: &mut MapState, value: &Value, project: Option<&Path>) -> Vec<SessionEventBody> {
    let Some(parent) = value
        .get("parent_tool_use_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
    else {
        return Vec::new();
    };
    step(state, &parent, value, project)
}

fn step(state: &mut MapState, parent: &str, value: &Value, project: Option<&Path>) -> Vec<SessionEventBody> {
    let child = state.children.entry(parent.to_string()).or_default();
    let events = match value.get("type").and_then(Value::as_str) {
        Some("assistant") => assistant_body(child, value, project, false),
        Some("user") => user_body(child, value, false, project),
        _ => Vec::new(),
    };
    events
        .into_iter()
        .filter(|event| {
            matches!(
                event,
                SessionEventBody::AgentMessage { .. } | SessionEventBody::Thinking { .. } | SessionEventBody::ToolCall { .. }
            )
        })
        .map(|event| SessionEventBody::SubagentStep {
            subagent_id: parent.to_string(),
            step: Box::new(event),
        })
        .collect()
}

/// 读历史时把子 Agent 自己的转录挂到卡片下面。实时已经推过的不重来。
fn replay_transcript(state: &mut MapState, tool_id: &str, agent_id: &str) -> Vec<SessionEventBody> {
    if state.children.contains_key(tool_id) {
        return Vec::new();
    }
    let Some(dir) = state.subagent_dir.clone() else {
        return Vec::new();
    };
    let Ok(content) = std::fs::read_to_string(dir.join(format!("agent-{agent_id}.jsonl"))) else {
        return Vec::new();
    };
    let mut events = Vec::new();
    for entry in transcript_entries(&content) {
        if entry.get("isMeta").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        events.extend(step(state, tool_id, &entry, None));
    }
    events
}

fn card_mut<'a>(state: &'a mut MapState, id: &str) -> &'a mut SubagentCard {
    state
        .subagents
        .entry(id.to_string())
        .or_insert_with(|| SubagentCard::new(id, ""))
}

fn apply_usage(card: &mut SubagentCard, usage: Option<&Value>) {
    let Some(usage) = usage else { return };
    card.tokens = usage.get("total_tokens").and_then(Value::as_i64).or(card.tokens);
    card.tool_uses = usage.get("tool_uses").and_then(Value::as_i64).or(card.tool_uses);
    card.duration_ms = usage.get("duration_ms").and_then(Value::as_i64).or(card.duration_ms);
}

fn status_of(status: &str) -> SubagentStatus {
    match status {
        "completed" => SubagentStatus::Completed,
        "failed" | "error" => SubagentStatus::Failed,
        "killed" | "stopped" | "cancelled" | "canceled" => SubagentStatus::Stopped,
        _ => SubagentStatus::Running,
    }
}

/// 子 Agent 交回的正文。CLI 在前面插的 `<tools-used-before-summary>` 那段不要。
fn report_text(value: &Value) -> String {
    value
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .map(str::trim)
                .filter(|text| !text.is_empty() && !text.starts_with("<tools-used-before-summary>"))
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default()
}

fn tag(content: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = content.find(&open)? + open.len();
    let end = start + content[start..].find(&close)?;
    let inner = content[start..end].trim();
    (!inner.is_empty()).then(|| inner.to_string())
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}
