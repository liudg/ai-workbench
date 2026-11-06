//! Codex 自带的子 Agent → 子 Agent 卡片和它自己的步骤。
//!
//! 子 Agent 是同一个 app-server 里的另一条原生线程。主线程上 `subAgentActivity` 报开始和结束
//! （`kind = started / completed`，带 `agentThreadId`、`agentPath`、`model`、`reasoningEffort`），
//! `collabAgentToolCall` 是派发、等待、发消息、关闭这些协作调用（带 `receiverThreadIds`、`prompt`、
//! `agentsStates`）。子线程自己的 `item/*`、`turn/*` 通知也从这条连接来，`threadId` 是子线程，
//! 不能进主时间线。卡片以子线程 id 为准。实测 codex-cli 0.165.0（2026-11-04）。
//!
//! 子线程的通知可能比主线程的 `subAgentActivity started` 先到（2026-11-05 实测：子线程的
//! `thread/status/changed` 早 1ms），认不出来的先存在 [`Foreign`] 里，卡片出现时再补上。

use std::collections::{HashMap, VecDeque};

use serde_json::{json, Value};

use aiwb_core::models::{now_millis, MessagePhase, SessionEventBody, SubagentCard, SubagentStatus};

use super::history::{reasoning_text, take_chars, tool_event, tool_view, tool_visible};
use super::state::{emit, Shared};

/// 主线程上一条子 Agent 相关的 item，改到哪些卡片就返回哪些。不是这两种 item 时返回 None。
pub(super) fn apply_item(
    cards: &mut HashMap<String, SubagentCard>,
    item: &Value,
    at: Option<i64>,
) -> Option<Vec<SessionEventBody>> {
    match item.get("type").and_then(Value::as_str)? {
        "subAgentActivity" => {
            let thread = text(item, "agentThreadId")?;
            let card = card_mut(cards, &thread);
            if let Some(path) = text(item, "agentPath") {
                if card.title.is_empty() {
                    card.title = path.rsplit('/').next().unwrap_or(&path).to_string();
                }
            }
            if let Some(model) = text(item, "model") {
                card.model = Some(model);
            }
            if let Some(effort) = text(item, "reasoningEffort") {
                card.effort = Some(effort);
            }
            match item.get("kind").and_then(Value::as_str).unwrap_or("") {
                "started" => {
                    card.started_at.get_or_insert_with(|| at.unwrap_or_else(now_millis));
                }
                kind => {
                    if let Some(status) = finished_status(kind) {
                        card.finish(status, at);
                    }
                }
            }
            Some(vec![SessionEventBody::Subagent(card.clone())])
        }
        "collabAgentToolCall" => {
            let receivers: Vec<String> = item
                .get("receiverThreadIds")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            let spawn = item.get("tool").and_then(Value::as_str) == Some("spawnAgent");
            let mut changed = Vec::new();
            for thread in &receivers {
                // 只认派出来的或已经有卡片的；对别的线程发消息不画卡片。
                if !spawn && !cards.contains_key(thread) {
                    continue;
                }
                let card = card_mut(cards, thread);
                if spawn {
                    if let Some(prompt) = text(item, "prompt") {
                        card.prompt = prompt;
                    }
                    if let Some(model) = text(item, "model") {
                        card.model = Some(model);
                    }
                    if let Some(effort) = text(item, "reasoningEffort") {
                        card.effort = Some(effort);
                    }
                    card.started_at.get_or_insert_with(|| at.unwrap_or_else(now_millis));
                }
                changed.push(thread.clone());
            }
            if let Some(states) = item.get("agentsStates").and_then(Value::as_object) {
                for (thread, state) in states {
                    let Some(card) = cards.get_mut(thread) else { continue };
                    if let Some(message) = text(state, "message") {
                        card.result = message;
                    }
                    if let Some(status) = state.get("status").and_then(Value::as_str).and_then(finished_status) {
                        card.finish(status, at);
                    }
                    if !changed.contains(thread) {
                        changed.push(thread.clone());
                    }
                }
            }
            Some(
                changed
                    .iter()
                    .filter_map(|thread| cards.get(thread))
                    .map(|card| SessionEventBody::Subagent(card.clone()))
                    .collect(),
            )
        }
        _ => None,
    }
}

/// 子线程的一条 item → 子 Agent 的一步。只留回答、思考和工具。
pub(super) fn step_of(item: &Value, completed: bool) -> Option<SessionEventBody> {
    let id = text(item, "id");
    if let Some(mut view) = tool_view(item) {
        if completed && view.status == aiwb_core::models::ToolStatus::Running {
            view.status = aiwb_core::models::ToolStatus::Completed;
        }
        return (tool_visible(&view) || !completed).then(|| tool_event(view, id));
    }
    if !completed {
        return None;
    }
    match item.get("type").and_then(Value::as_str)? {
        "agentMessage" => {
            let text = item.get("text").and_then(Value::as_str).unwrap_or("").trim();
            (!text.is_empty()).then(|| SessionEventBody::AgentMessage {
                text: take_chars(text, 20_000),
                stream_id: id,
                phase: MessagePhase::parse(item.get("phase").and_then(Value::as_str)),
                mode: None,
                dedupe_of: None,
            })
        }
        "reasoning" => {
            let text = reasoning_text(item);
            (!text.trim().is_empty()).then(|| SessionEventBody::Thinking {
                text: take_chars(&text, 20_000),
                stream_id: id,
            })
        }
        _ => None,
    }
}

/// 读历史时主线程各回合里的子 Agent 卡片。
pub(super) fn cards_from_turns(turns: &[Value]) -> Vec<SubagentCard> {
    let mut cards = HashMap::new();
    let mut order = Vec::new();
    for item in turns
        .iter()
        .filter_map(|turn| turn.get("items").and_then(Value::as_array))
        .flatten()
    {
        if let Some(changed) = apply_item(&mut cards, item, None) {
            for body in changed {
                if let SessionEventBody::Subagent(card) = body {
                    if !order.contains(&card.subagent_id) {
                        order.push(card.subagent_id);
                    }
                }
            }
        }
    }
    order.into_iter().filter_map(|id| cards.remove(&id)).collect()
}

/// 存着的别的线程的通知。最多存这么多条线程、每条这么多通知，再多就丢最早的。
const FOREIGN_THREADS: usize = 16;
const FOREIGN_PER_THREAD: usize = 256;

#[derive(Default)]
pub(super) struct Foreign {
    threads: VecDeque<(String, Vec<(String, Value)>)>,
}

impl Foreign {
    fn keep(&mut self, thread: &str, method: &str, params: &Value) {
        let slot = match self.threads.iter().position(|(id, _)| id == thread) {
            Some(index) => index,
            None => {
                if self.threads.len() >= FOREIGN_THREADS {
                    self.threads.pop_front();
                }
                self.threads.push_back((thread.to_string(), Vec::new()));
                self.threads.len() - 1
            }
        };
        let list = &mut self.threads[slot].1;
        if list.len() < FOREIGN_PER_THREAD {
            list.push((method.to_string(), params.clone()));
        }
    }

    fn take(&mut self, thread: &str) -> Vec<(String, Value)> {
        match self.threads.iter().position(|(id, _)| id == thread) {
            Some(index) => self.threads.remove(index).map(|(_, list)| list).unwrap_or_default(),
            None => Vec::new(),
        }
    }
}

impl Shared {
    /// 不是本会话线程的通知。已知的子线程归到它的卡片下面，认不出来的先存着。
    /// 还没有自己的线程 id 时不拦。
    pub(super) fn route_foreign_thread(&self, method: &str, params: &Value) -> bool {
        let Some(thread) = params.get("threadId").and_then(Value::as_str) else {
            return false;
        };
        let ours = self.thread_id.lock().unwrap().clone();
        if ours.is_none() || ours.as_deref() == Some(thread) {
            return false;
        }
        if self.subagents.lock().unwrap().contains_key(thread) {
            self.on_subagent_thread(thread, method, params);
        } else {
            self.foreign.lock().unwrap().keep(thread, method, params);
        }
        true
    }

    /// 主线程上的子 Agent item。是的话发卡片并返回 true。新认出来的子线程补上它先到的通知。
    pub(super) fn on_subagent_item(&self, item: &Value) -> bool {
        let changed = apply_item(&mut self.subagents.lock().unwrap(), item, Some(now_millis()));
        let Some(changed) = changed else {
            return false;
        };
        let mut threads = Vec::new();
        for body in changed {
            if let SessionEventBody::Subagent(card) = &body {
                threads.push(card.subagent_id.clone());
            }
            emit(&self.events, body);
        }
        for thread in threads {
            let early = self.foreign.lock().unwrap().take(&thread);
            for (method, params) in early {
                self.on_subagent_thread(&thread, &method, &params);
            }
        }
        true
    }

    /// 单独停一个子 Agent：打断子线程正在跑的回合。
    pub(super) fn stop_subagent(&self, thread: &str) -> Result<(), crate::AgentError> {
        let turn = self.subagent_turns.lock().unwrap().get(thread).cloned();
        let Some(turn) = turn else {
            return Err(crate::AgentError::Runtime("这个子 Agent 没有在跑".into()));
        };
        if !self.write_method("turn/interrupt", json!({ "threadId": thread, "turnId": turn })) {
            return Err(crate::AgentError::Runtime("无法向 Codex CLI 写入消息".into()));
        }
        Ok(())
    }

    fn on_subagent_thread(&self, thread: &str, method: &str, params: &Value) {
        match method {
            "turn/started" => {
                if let Some(turn) = params.pointer("/turn/id").and_then(Value::as_str) {
                    self.subagent_turns.lock().unwrap().insert(thread.to_string(), turn.to_string());
                }
            }
            "item/started" | "item/completed" => {
                let completed = method == "item/completed";
                let Some(item) = params.get("item") else { return };
                let Some(step) = step_of(item, completed) else { return };
                if let SessionEventBody::AgentMessage { text, .. } = &step {
                    if let Some(card) = self.subagents.lock().unwrap().get_mut(thread) {
                        card.result = text.clone();
                    }
                }
                emit(
                    &self.events,
                    SessionEventBody::SubagentStep {
                        subagent_id: thread.to_string(),
                        step: Box::new(step),
                    },
                );
            }
            "turn/completed" => {
                self.subagent_turns.lock().unwrap().remove(thread);
                let status = match params.pointer("/turn/status").and_then(Value::as_str) {
                    Some("failed") => SubagentStatus::Failed,
                    Some("interrupted") => SubagentStatus::Stopped,
                    _ => SubagentStatus::Completed,
                };
                let mut cards = self.subagents.lock().unwrap();
                let Some(card) = cards.get_mut(thread) else { return };
                if status == SubagentStatus::Failed {
                    if let Some(message) = params.pointer("/turn/error/message").and_then(Value::as_str) {
                        card.result = message.to_string();
                    }
                }
                card.finish(status, Some(now_millis()));
                emit(&self.events, SessionEventBody::Subagent(card.clone()));
            }
            "thread/tokenUsage/updated" => {
                let Some(total) = params.pointer("/tokenUsage/total/totalTokens").and_then(Value::as_i64) else {
                    return;
                };
                let mut cards = self.subagents.lock().unwrap();
                let Some(card) = cards.get_mut(thread) else { return };
                card.tokens = Some(total);
                emit(&self.events, SessionEventBody::Subagent(card.clone()));
            }
            _ => {}
        }
    }

    /// 读历史后补上子 Agent：记下卡片，读各子线程的过程和最后的回答。
    pub(super) async fn load_subagents(&self, turns: &[Value]) {
        for mut card in cards_from_turns(turns) {
            let thread = card.subagent_id.clone();
            if let Ok(result) = self
                .request("thread/read", json!({ "threadId": thread, "includeTurns": true }))
                .await
            {
                let snapshot = result.get("thread").unwrap_or(&Value::Null);
                if let Some(name) = text(snapshot, "agentRole").or_else(|| text(snapshot, "agentNickname")) {
                    card.agent_type = name;
                }
                let turns = snapshot.get("turns").and_then(Value::as_array).cloned().unwrap_or_default();
                for item in turns.iter().filter_map(|turn| turn.get("items").and_then(Value::as_array)).flatten() {
                    let Some(step) = step_of(item, true) else { continue };
                    if let SessionEventBody::AgentMessage { text, .. } = &step {
                        card.result = text.clone();
                    }
                    emit(
                        &self.events,
                        SessionEventBody::SubagentStep {
                            subagent_id: thread.clone(),
                            step: Box::new(step),
                        },
                    );
                }
                let first = turns.first().and_then(|turn| turn.get("startedAt")).and_then(Value::as_i64);
                let last = turns.last().and_then(|turn| turn.get("completedAt")).and_then(Value::as_i64);
                card.started_at = card.started_at.or(first.map(|secs| secs * 1000));
                card.ended_at = card.ended_at.or(last.map(|secs| secs * 1000));
            }
            emit(&self.events, SessionEventBody::Subagent(card.clone()));
            self.subagents.lock().unwrap().insert(thread, card);
        }
    }

    /// 进程没了，还在跑的子 Agent 也跟着停了。
    pub(super) fn stop_subagents(&self) {
        let at = Some(now_millis());
        for card in self.subagents.lock().unwrap().values_mut() {
            if card.status == SubagentStatus::Running {
                card.finish(SubagentStatus::Stopped, at);
                emit(&self.events, SessionEventBody::Subagent(card.clone()));
            }
        }
    }
}

fn card_mut<'a>(cards: &'a mut HashMap<String, SubagentCard>, thread: &str) -> &'a mut SubagentCard {
    cards
        .entry(thread.to_string())
        .or_insert_with(|| SubagentCard::new(thread, ""))
}

/// `subAgentActivity.kind` 和 `agentsStates.*.status` 里表示结束的值。
fn finished_status(kind: &str) -> Option<SubagentStatus> {
    match kind {
        "completed" => Some(SubagentStatus::Completed),
        "failed" | "errored" => Some(SubagentStatus::Failed),
        "interrupted" | "shutdown" | "closed" | "stopped" => Some(SubagentStatus::Stopped),
        _ => None,
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    //! 报文从 codex-cli 0.165.0 app-server 实录（2026-11-04）里截出来，去掉了无关字段。
    use std::sync::atomic::Ordering;

    use super::*;

    const MAIN: &str = "01a1a4f2-a7aa-75b0-a0cc-8dea31f759c2";
    const PING: &str = "01a1a4f2-d4a3-7d21-8f9d-052388662b84";

    fn harness() -> (Shared, tokio::sync::mpsc::UnboundedReceiver<SessionEventBody>) {
        let (events_tx, events_rx) = tokio::sync::mpsc::unbounded_channel();
        let (out_tx, _out_rx) = tokio::sync::mpsc::unbounded_channel();
        let shared = Shared::for_test(events_tx, out_tx);
        *shared.thread_id.lock().unwrap() = Some(MAIN.into());
        (shared, events_rx)
    }

    fn drain(events: &mut tokio::sync::mpsc::UnboundedReceiver<SessionEventBody>) -> Vec<SessionEventBody> {
        std::iter::from_fn(|| events.try_recv().ok()).collect()
    }

    fn activity(kind: &str, id: &str) -> Value {
        json!({
            "item": {
                "type": "subAgentActivity", "model": if kind == "started" { json!("gpt-6-astra") } else { Value::Null },
                "reasoningEffort": if kind == "started" { json!("low") } else { Value::Null },
                "id": id, "kind": kind, "agentThreadId": PING, "agentPath": "/root/ping"
            },
            "threadId": MAIN,
            "turnId": "turn-main",
        })
    }

    /// 子线程的回合、条目和状态都不进主会话，挂到子 Agent 下面；子线程的回合结束不收主回合。
    #[test]
    fn subagent_thread_stays_out_of_the_main_session() {
        let (shared, mut events) = harness();
        shared.turn_open.store(true, Ordering::SeqCst);
        *shared.turn_id.lock().unwrap() = Some("turn-main".into());
        shared.handle_notification("item/started", &activity("started", "call_3e8a"));
        let card = match drain(&mut events).as_slice() {
            [SessionEventBody::Subagent(card)] => card.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(card.subagent_id, PING);
        assert_eq!(card.title, "ping");
        assert_eq!(card.model.as_deref(), Some("gpt-6-astra"));
        assert_eq!(card.effort.as_deref(), Some("low"));
        assert_eq!(card.status, SubagentStatus::Running);

        shared.handle_notification(
            "turn/started",
            &json!({ "threadId": PING, "turn": { "id": "turn-ping", "status": "inProgress" } }),
        );
        shared.handle_notification("thread/status/changed", &json!({ "threadId": PING, "status": { "type": "active" } }));
        shared.handle_notification(
            "item/completed",
            &json!({ "threadId": PING, "turnId": "turn-ping", "item": {
                "type": "commandExecution", "id": "exec-1", "command": "echo PING", "status": "completed",
                "commandActions": [{ "type": "unknown", "command": "echo PING" }],
                "aggregatedOutput": "PING\r\n", "exitCode": 0
            }}),
        );
        shared.handle_notification(
            "item/agentMessage/delta",
            &json!({ "threadId": PING, "itemId": "msg_p", "delta": "PI" }),
        );
        shared.handle_notification(
            "item/completed",
            &json!({ "threadId": PING, "turnId": "turn-ping", "item": {
                "type": "agentMessage", "id": "msg_p", "text": "PING", "phase": "final_answer"
            }}),
        );
        shared.handle_notification(
            "turn/completed",
            &json!({ "threadId": PING, "turn": { "id": "turn-ping", "status": "completed" } }),
        );
        let bodies = drain(&mut events);
        assert!(
            bodies
                .iter()
                .all(|body| matches!(body, SessionEventBody::SubagentStep { subagent_id, .. } if subagent_id == PING)
                    || matches!(body, SessionEventBody::Subagent(_))),
            "{bodies:?}"
        );
        assert!(bodies.iter().any(|body| matches!(body,
            SessionEventBody::SubagentStep { step, .. } if matches!(&**step, SessionEventBody::ToolCall { .. }))));
        assert!(shared.turn_open.load(Ordering::SeqCst), "子线程结束不收主回合");
        assert_eq!(shared.turn_id.lock().unwrap().as_deref(), Some("turn-main"));

        shared.handle_notification("item/completed", &activity("completed", "subagent-completed-turn-ping"));
        let card = match drain(&mut events).as_slice() {
            [SessionEventBody::Subagent(card)] => card.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(card.status, SubagentStatus::Completed);
        assert_eq!(card.result, "PING");
        assert_eq!(card.model.as_deref(), Some("gpt-6-astra"), "结束那条没带模型，不清掉");
    }

    /// 子线程的通知比主线程的 `subAgentActivity started` 先到（2026-11-05 实录里 `thread/status/changed`
    /// 早 1ms）：先存着，卡片出现时补上，不丢步骤；之后能按子线程的回合单独停它。
    #[test]
    fn early_child_notifications_are_kept_until_the_card_appears() {
        let (events_tx, mut events) = tokio::sync::mpsc::unbounded_channel();
        let (out_tx, mut out) = tokio::sync::mpsc::unbounded_channel();
        let shared = Shared::for_test(events_tx, out_tx);
        *shared.thread_id.lock().unwrap() = Some(MAIN.into());
        shared.handle_notification(
            "turn/started",
            &json!({ "threadId": PING, "turn": { "id": "turn-ping", "status": "inProgress" } }),
        );
        shared.handle_notification(
            "item/completed",
            &json!({ "threadId": PING, "turnId": "turn-ping", "item": {
                "type": "agentMessage", "id": "msg_p", "text": "PING", "phase": "final_answer"
            }}),
        );
        assert!(drain(&mut events).is_empty(), "还认不出来时什么都不发");
        shared.handle_notification("item/started", &activity("started", "call_3e8a"));
        let bodies = drain(&mut events);
        assert!(matches!(bodies.first(), Some(SessionEventBody::Subagent(card)) if card.subagent_id == PING), "{bodies:?}");
        assert!(bodies.iter().any(|body| matches!(body,
            SessionEventBody::SubagentStep { subagent_id, step } if subagent_id == PING
                && matches!(&**step, SessionEventBody::AgentMessage { text, .. } if text == "PING"))));

        while out.try_recv().is_ok() {}
        shared.stop_subagent(PING).unwrap();
        let sent: Value = serde_json::from_str(&out.try_recv().expect("写出了打断")).unwrap();
        assert_eq!(sent["method"], "turn/interrupt");
        assert_eq!(sent["params"]["threadId"], PING);
        assert_eq!(sent["params"]["turnId"], "turn-ping");
    }

    /// 没登记过的别的线程直接丢掉；本会话自己的照常处理。
    #[test]
    fn unknown_threads_are_dropped() {
        let (shared, mut events) = harness();
        shared.handle_notification(
            "item/completed",
            &json!({ "threadId": "other", "item": { "type": "agentMessage", "id": "m1", "text": "别处" } }),
        );
        assert!(drain(&mut events).is_empty());
        shared.handle_notification(
            "item/completed",
            &json!({ "threadId": MAIN, "item": { "type": "agentMessage", "id": "m2", "text": "这里" } }),
        );
        assert!(drain(&mut events)
            .iter()
            .any(|body| matches!(body, SessionEventBody::AgentMessage { text, .. } if text == "这里")));
    }

    /// 历史里的子 Agent 在原位置画卡片，开始和结束并成同一张。`wait` 这类协作调用不画。
    #[test]
    fn history_turns_keep_cards_in_place() {
        let turns = vec![json!({ "id": "turn-main", "items": [
            { "type": "userMessage", "id": "u1", "content": [{ "type": "text", "text": "派两个子 Agent" }] },
            activity("started", "call_3e8a")["item"].clone(),
            { "type": "collabAgentToolCall", "id": "call_wait", "tool": "wait", "status": "completed",
              "senderThreadId": MAIN, "receiverThreadIds": [], "agentsStates": {} },
            activity("completed", "subagent-completed-turn-ping")["item"].clone(),
            { "type": "agentMessage", "id": "m1", "text": "PING", "phase": "final_answer" },
        ]})];
        let bodies = super::super::history::bodies_from_turns(&turns);
        let kinds: Vec<_> = bodies
            .iter()
            .map(|body| match body {
                SessionEventBody::UserMessage { .. } => "user",
                SessionEventBody::Subagent(card) if card.status == SubagentStatus::Running => "started",
                SessionEventBody::Subagent(_) => "done",
                SessionEventBody::AgentMessage { .. } => "agent",
                SessionEventBody::TurnAnchor { .. } => "anchor",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, ["user", "anchor", "started", "done", "agent"]);
        let cards = cards_from_turns(&turns);
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].status, SubagentStatus::Completed);
    }
}
