//! Cursor 自带的子 Agent → 子 Agent 卡片和它自己的步骤。
//!
//! `initialize` 声明 `clientCapabilities._meta.subagents` 后 Cursor 才报子 Agent（`types.ts` 的 `h`）。
//! 对照本机 Cursor Agent 2026.10.22-27dcf5f 的 `3635.index.js`（`SubagentPublisher`）和 2026-11-05 的实际收发：
//! - 主会话先发 `Task` 工具调用（`rawInput._toolName = task`，带 `description`、`prompt`），
//!   再发 `subagent_spawned`（`subagentSessionId`、`name`、截短的 `task`，`_meta.cursor.toolCallId` 对上工具调用）。
//! - 子 Agent 自己的过程是 `sessionId = subagentSessionId` 的 `session/update`，形状和主会话一样。
//! - 结束是主会话上的 `subagent_state_update`，`state` 取 `completed` / `failed` / `cancelled` / `disconnected`。
//! - `cursor/task` 请求带用时和模型。
//!
//! 卡片以工具调用 id 为准；子会话的更新用一份自己的 [`UpdateMap`] 翻成步骤。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use aiwb_core::models::{now_millis, SessionEventBody, SubagentCard, SubagentStatus, ToolStatus};

use super::updates::UpdateMap;

struct Child {
    card: String,
    map: UpdateMap,
    /// 最后一句回答。子 Agent 结束时当结果。
    answer: String,
}

pub struct Subagents {
    project: PathBuf,
    cards: HashMap<String, SubagentCard>,
    /// 原始工具调用 id → 卡片 id。
    tools: HashMap<String, String>,
    /// 子会话 id → 子 Agent。
    children: HashMap<String, Child>,
}

impl Subagents {
    pub fn new(project: &Path) -> Self {
        Self {
            project: project.to_path_buf(),
            cards: HashMap::new(),
            tools: HashMap::new(),
            children: HashMap::new(),
        }
    }

    /// 子 Agent 相关的一条 `session/update`：派它的工具调用、开始和结束、子会话自己的过程。
    /// 不相关时返回 None，按主会话处理。
    pub fn apply(&mut self, session_id: &str, update: &Value) -> Option<Vec<SessionEventBody>> {
        if self.children.contains_key(session_id) {
            return Some(self.child_update(session_id, update));
        }
        match update.get("sessionUpdate").and_then(Value::as_str)? {
            "tool_call" if is_task(update) => Some(self.task_call(update)),
            "tool_call_update" if self.tools.contains_key(text(update, "toolCallId")?.as_str()) => {
                Some(self.task_update(update))
            }
            "subagent_spawned" => Some(self.spawned(update)),
            "subagent_state_update" => Some(self.state(update)),
            _ => None,
        }
    }

    /// `cursor/task`：子 Agent 跑完后补上用时和模型。
    pub fn task_done(&mut self, params: &Value) -> Vec<SessionEventBody> {
        let Some(card) = text(params, "toolCallId").and_then(|id| self.tools.get(&id).cloned()) else {
            return Vec::new();
        };
        let Some(card) = self.cards.get_mut(&card) else {
            return Vec::new();
        };
        if let Some(ms) = params.get("durationMs").and_then(Value::as_i64) {
            card.duration_ms = Some(ms);
        }
        if let Some(model) = text(params, "model") {
            card.model = Some(model);
        }
        vec![SessionEventBody::Subagent(card.clone())]
    }

    /// 进程没了或回合被打断，还在跑的子 Agent 也跟着停了。
    pub fn stop_all(&mut self) -> Vec<SessionEventBody> {
        let at = Some(now_millis());
        self.cards
            .values_mut()
            .filter(|card| card.status == SubagentStatus::Running)
            .map(|card| {
                card.finish(SubagentStatus::Stopped, at);
                SessionEventBody::Subagent(card.clone())
            })
            .collect()
    }

    fn task_call(&mut self, update: &Value) -> Vec<SessionEventBody> {
        let Some(tool) = text(update, "toolCallId") else {
            return Vec::new();
        };
        let input = update.get("rawInput").unwrap_or(&Value::Null);
        let id = card_id(&tool);
        let card = self.cards.entry(id.clone()).or_insert_with(|| SubagentCard::new(&id, ""));
        if let Some(title) = text(input, "description").or_else(|| {
            text(update, "title").map(|title| title.strip_prefix("Task: ").unwrap_or(&title).to_string())
        }) {
            card.title = title;
        }
        if let Some(prompt) = text(input, "prompt") {
            card.prompt = prompt;
        }
        if let Some(model) = text(input, "model") {
            card.model = Some(model);
        }
        card.started_at.get_or_insert_with(now_millis);
        self.tools.insert(tool, id.clone());
        vec![SessionEventBody::Subagent(card.clone())]
    }

    /// 工具调用的更新。后台跑的子 Agent 工具调用当场就完成，以 `subagent_state_update` 为准。
    fn task_update(&mut self, update: &Value) -> Vec<SessionEventBody> {
        let Some(card) = text(update, "toolCallId").and_then(|tool| self.tools.get(&tool).cloned()) else {
            return Vec::new();
        };
        let Some(card) = self.cards.get_mut(&card) else {
            return Vec::new();
        };
        let output = update.get("rawOutput").unwrap_or(&Value::Null);
        if output.get("isBackground").and_then(Value::as_bool) == Some(true) {
            card.background = true;
        }
        if let Some(ms) = output.get("durationMs").and_then(Value::as_i64) {
            card.duration_ms = Some(ms);
        }
        if !card.background {
            match update.get("status").and_then(Value::as_str) {
                Some("completed") => card.finish(SubagentStatus::Completed, Some(now_millis())),
                Some("failed") => card.finish(SubagentStatus::Failed, Some(now_millis())),
                _ => {}
            }
        }
        vec![SessionEventBody::Subagent(card.clone())]
    }

    fn spawned(&mut self, update: &Value) -> Vec<SessionEventBody> {
        let Some(session) = text(update, "subagentSessionId") else {
            return Vec::new();
        };
        let meta = update.pointer("/_meta/cursor").unwrap_or(&Value::Null);
        let tool = text(meta, "toolCallId");
        let id = tool
            .as_ref()
            .and_then(|tool| self.tools.get(tool).cloned())
            .unwrap_or_else(|| card_id(tool.as_deref().unwrap_or(&session)));
        if let Some(tool) = tool {
            self.tools.insert(tool, id.clone());
        }
        let card = self.cards.entry(id.clone()).or_insert_with(|| SubagentCard::new(&id, ""));
        if let Some(name) = text(update, "name") {
            card.agent_type = name;
        }
        if card.prompt.is_empty() {
            if let Some(task) = text(update, "task") {
                card.prompt = task;
            }
        }
        if let Some(model) = text(meta, "model") {
            card.model = Some(model);
        }
        // 同一个子 Agent 被接着用时是新的一段，状态重新算。
        if card.status != SubagentStatus::Running {
            card.status = SubagentStatus::Running;
            card.ended_at = None;
            card.duration_ms = None;
        }
        card.started_at.get_or_insert_with(now_millis);
        let mut map = UpdateMap::new(&self.project);
        map.begin_turn(&format!("sub-{id}"));
        self.children.insert(
            session,
            Child {
                card: id,
                map,
                answer: String::new(),
            },
        );
        vec![SessionEventBody::Subagent(card.clone())]
    }

    fn state(&mut self, update: &Value) -> Vec<SessionEventBody> {
        let Some(session) = text(update, "subagentSessionId") else {
            return Vec::new();
        };
        let Some(child) = self.children.get(&session) else {
            return Vec::new();
        };
        let Some(card) = self.cards.get_mut(&child.card) else {
            return Vec::new();
        };
        if let Some(model) = update.pointer("/_meta/cursor/model").and_then(Value::as_str) {
            card.model = Some(model.to_string());
        }
        let status = match update.get("state").and_then(Value::as_str).unwrap_or("") {
            "completed" => SubagentStatus::Completed,
            "failed" => SubagentStatus::Failed,
            "cancelled" | "disconnected" => SubagentStatus::Stopped,
            _ => return vec![SessionEventBody::Subagent(card.clone())],
        };
        if !child.answer.trim().is_empty() {
            card.result = child.answer.trim().to_string();
        }
        card.finish(status, Some(now_millis()));
        vec![SessionEventBody::Subagent(card.clone())]
    }

    /// 子会话自己的更新：回答、思考、工具调用变成步骤，正在跑的工具当作它在做什么。
    fn child_update(&mut self, session: &str, update: &Value) -> Vec<SessionEventBody> {
        let Some(child) = self.children.get_mut(session) else {
            return Vec::new();
        };
        let mut events = Vec::new();
        let mut card_changed = false;
        for body in child.map.apply(update) {
            match &body {
                SessionEventBody::AgentMessage { text, .. } => child.answer = text.clone(),
                SessionEventBody::Thinking { .. } => {}
                SessionEventBody::ToolCall { summary, status, .. } => {
                    if let Some(card) = self.cards.get_mut(&child.card) {
                        if *status == ToolStatus::Running && card.activity != *summary {
                            card.activity = summary.clone();
                            card_changed = true;
                        }
                    }
                }
                _ => continue,
            }
            events.push(SessionEventBody::SubagentStep {
                subagent_id: child.card.clone(),
                step: Box::new(body),
            });
        }
        if card_changed {
            if let Some(card) = self.cards.get(&child.card) {
                events.push(SessionEventBody::Subagent(card.clone()));
            }
        }
        events
    }
}

fn is_task(update: &Value) -> bool {
    update.pointer("/rawInput/_toolName").and_then(Value::as_str) == Some("task")
}

/// 工具调用 id 里带换行（`call-…\nfc_…`），换成连字符当卡片 id。
fn card_id(tool: &str) -> String {
    tool.replace('\n', "-")
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}
