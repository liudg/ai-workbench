//! Antigravity 自带的子 Agent → 子 Agent 卡片和它自己的步骤。
//!
//! ACP 只报派子 Agent 的工具调用 `invoke_subagent`（`rawInput` 带 `Prompt`、`Role`、`TypeName`），派完马上算完成，
//! 子会话的过程不走 `session/update`（2026-11-09 agy 1.5.3 实测）。过程只落在磁盘上：
//! - `brain/<主会话>/.system_generated/subagents/<子会话>.json`：`subagentDescriptor.role`、`state`。
//! - `brain/<子会话>/.system_generated/logs/transcript.jsonl`：一行一步。`PLANNER_RESPONSE` 带 `content` 和
//!   `tool_calls`（`args` 的值是 JSON 编码过的字符串），下一条 `GENERIC` 是工具结果。
//!
//! 子 Agent 用 `send_message` 把结果发回主会话，没有工具调用的 `PLANNER_RESPONSE` 就是它的最后一步。

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::dialect::RULES;
use super::directory;
use crate::acp::updates::UpdateMap;
use crate::EventSink;
use aiwb_core::models::{now_millis, SessionEventBody, SubagentCard, SubagentStatus, ToolStatus};

const POLL: Duration = Duration::from_millis(500);
/// `ERROR_MESSAGE` 多半是在重试（`API error (attempt 1)`）。这么久没有新进展才算失败。
const ERROR_GRACE: Duration = Duration::from_secs(60);

/// 把转录的一步翻成 `session/update`。主会话和子会话共用。
#[derive(Default)]
pub struct Transcript {
    prefix: String,
    /// 等结果的工具调用，空串表示不显示的 `send_message`。
    pending: VecDeque<String>,
    next_tool: u64,
}

/// 转录里的一步翻出来的结果。
#[derive(Default)]
pub struct Step {
    pub updates: Vec<Value>,
    /// 回答或发回主会话的结果。
    pub answer: Option<String>,
    /// 没有工具调用的回答，这个 Agent 这一段做完了。
    pub finished: bool,
    /// 模型调用出错，后面可能还会重试。
    pub errored: bool,
}

impl Transcript {
    fn new(prefix: &str) -> Self {
        Self { prefix: prefix.to_string(), ..Self::default() }
    }

    pub fn step(&mut self, step: &Value) -> Step {
        match step.get("type").and_then(Value::as_str).unwrap_or("") {
            "PLANNER_RESPONSE" => self.planner_response(step),
            "GENERIC" => self.tool_result(step),
            "ERROR_MESSAGE" => Step { errored: true, ..Step::default() },
            _ => Step::default(),
        }
    }

    fn planner_response(&mut self, step: &Value) -> Step {
        let mut out = Step::default();
        if let Some(content) = step.get("content").and_then(Value::as_str).filter(|text| !text.trim().is_empty()) {
            out.answer = Some(content.trim().to_string());
            out.updates.push(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": content } }));
        }
        let calls = step.get("tool_calls").and_then(Value::as_array).cloned().unwrap_or_default();
        for call in &calls {
            let name = call.get("name").and_then(Value::as_str).unwrap_or("");
            let input = decoded_args(call.get("args"));
            if name == "send_message" {
                if let Some(message) = text(&input, "Message") {
                    out.answer = Some(message);
                }
                self.pending.push_back(String::new());
                continue;
            }
            self.next_tool += 1;
            let tool = format!("{}-{}", self.prefix, self.next_tool);
            self.pending.push_back(tool.clone());
            out.updates.push(json!({
                "sessionUpdate": "tool_call", "toolCallId": tool, "name": name, "status": "in_progress",
                "kind": kind_of(name), "title": name, "rawInput": input,
            }));
        }
        out.finished = calls.is_empty();
        out
    }

    fn tool_result(&mut self, step: &Value) -> Step {
        let mut out = Step::default();
        let Some(tool) = self.pending.pop_front().filter(|tool| !tool.is_empty()) else {
            return out;
        };
        let body = strip_step_times(step.get("content").and_then(Value::as_str).unwrap_or(""));
        let failed = step.get("status").and_then(Value::as_str) != Some("DONE");
        out.updates.push(json!({
            "sessionUpdate": "tool_call_update", "toolCallId": tool, "status": if failed { "failed" } else { "completed" },
            "content": [{ "type": "content", "content": { "type": "text", "text": body } }],
        }));
        out
    }
}

/// `brain/<会话>/.system_generated/logs/transcript.jsonl` 里从第 `seen` 行起写完的行。返回解析好的步骤和新的行数。
fn read_transcript(id: &str, seen: usize) -> Option<(Vec<Value>, usize)> {
    let path = directory::brain_dir(id)?.join(".system_generated").join("logs").join("transcript.jsonl");
    let raw = std::fs::read_to_string(path).ok()?;
    let lines: Vec<&str> = raw.lines().collect();
    // 最后一行可能写到一半。
    let complete = if raw.ends_with('\n') { lines.len() } else { lines.len().saturating_sub(1) };
    if complete <= seen {
        return Some((Vec::new(), complete));
    }
    let steps = lines[seen..complete]
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect();
    Some((steps, complete))
}

/// 转成后台任务的命令跑完了：命令原文和结果原文。
pub struct FinishedTask {
    pub command: String,
    pub result: String,
}

/// 主会话在回合回包之后的动静：子 Agent 回报、后台任务结束、被它们唤醒后的回答。
pub struct ParentTail {
    id: String,
    lines: usize,
    transcript: Transcript,
    /// 已经写进转录的子 Agent 消息来源。
    heard: HashSet<String>,
    idle: bool,
    /// 发出去还没结果的工具调用。
    open_tools: usize,
    errored: bool,
    /// 还没结束的后台任务：任务 id → 命令原文。
    tasks: HashMap<String, String>,
    finished: Vec<FinishedTask>,
}

impl ParentTail {
    pub fn new(id: &str) -> Self {
        let mut heard = HashSet::new();
        let mut idle = false;
        let mut lines = 0;
        let mut open_tools = 0;
        let mut tasks = HashMap::new();
        if let Some((steps, total)) = read_transcript(id, 0) {
            lines = total;
            for step in &steps {
                note_sender(step, &mut heard);
                note_task(step, &mut tasks);
                idle = is_final(step);
                open_tools = next_open_tools(open_tools, step);
            }
        }
        tasks.retain(|task, _| !heard.contains(task));
        Self {
            id: id.to_string(),
            lines,
            transcript: Transcript::new(&format!("parent-{id}")),
            heard,
            idle,
            open_tools,
            errored: false,
            tasks,
            finished: Vec::new(),
        }
    }

    /// 读新增的步骤。
    pub fn read(&mut self) -> Vec<Value> {
        let Some((steps, lines)) = read_transcript(&self.id, self.lines) else {
            return Vec::new();
        };
        self.lines = lines.max(self.lines);
        let mut updates = Vec::new();
        for step in &steps {
            note_sender(step, &mut self.heard);
            note_task(step, &mut self.tasks);
            if let Some((task, result)) = task_result(step) {
                if let Some(command) = self.tasks.remove(&task) {
                    self.finished.push(FinishedTask { command, result });
                }
            }
            self.idle = is_final(step);
            self.open_tools = next_open_tools(self.open_tools, step);
            let out = self.transcript.step(step);
            self.errored = out.errored;
            updates.extend(out.updates);
        }
        updates
    }

    /// 最后一步是模型调用出错。
    pub fn errored(&self) -> bool {
        self.errored
    }

    /// 主会话发了工具调用，结果还没回来。
    pub fn waiting_on_tool(&self) -> bool {
        self.open_tools > 0
    }

    /// 有转成后台任务、还没结束的命令。
    pub fn waiting_on_tasks(&self) -> bool {
        !self.tasks.is_empty()
    }

    /// 读到结束消息的后台任务。读一次就清掉。
    pub fn take_finished(&mut self) -> Vec<FinishedTask> {
        std::mem::take(&mut self.finished)
    }

    /// 这些子 Agent 的消息都收到了，后台任务都结束了，主会话也回完话了。
    pub fn settled(&self, children: &[String]) -> bool {
        self.idle && self.tasks.is_empty() && children.iter().all(|child| self.heard.contains(child))
    }
}

const TASK_STARTED: &str = "running as a background task with task id: ";

/// 命令等太久转成后台任务时，工具结果是
/// `Tool is running as a background task with task id: <id>\nTask Description: <命令>`。
fn note_task(step: &Value, tasks: &mut HashMap<String, String>) {
    if step.get("type").and_then(Value::as_str) != Some("GENERIC") {
        return;
    }
    let Some(content) = step.get("content").and_then(Value::as_str) else {
        return;
    };
    let Some((_, rest)) = content.split_once(TASK_STARTED) else {
        return;
    };
    let id = rest.lines().next().unwrap_or("").trim().to_string();
    let command = content
        .lines()
        .find_map(|line| line.strip_prefix("Task Description: "))
        .unwrap_or("")
        .trim()
        .to_string();
    if !id.is_empty() {
        tasks.insert(id, command);
    }
}

/// 任务结束的系统消息：`sender=<任务 id> … content=Task id "<id>" finished with result:\n<结果>\n\nLog: …`。
fn task_result(step: &Value) -> Option<(String, String)> {
    if step.get("type").and_then(Value::as_str) != Some("SYSTEM_MESSAGE") {
        return None;
    }
    let content = step.get("content").and_then(Value::as_str)?;
    let (head, rest) = content.split_once("\" finished with result:\n")?;
    let task = head.rsplit_once("Task id \"")?.1.to_string();
    let result = rest.split("\n\nLog: ").next().unwrap_or(rest).trim_end().to_string();
    Some((task, result))
}

fn next_open_tools(open: usize, step: &Value) -> usize {
    match step.get("type").and_then(Value::as_str) {
        Some("PLANNER_RESPONSE") => open + step.get("tool_calls").and_then(Value::as_array).map_or(0, Vec::len),
        Some("GENERIC") => open.saturating_sub(1),
        _ => open,
    }
}

fn is_final(step: &Value) -> bool {
    step.get("type").and_then(Value::as_str) == Some("PLANNER_RESPONSE")
        && step.get("tool_calls").and_then(Value::as_array).is_none_or(|calls| calls.is_empty())
}

/// 子 Agent 的消息写成 `[Message] timestamp=… sender=<会话 id> …`。
fn note_sender(step: &Value, heard: &mut HashSet<String>) {
    if step.get("type").and_then(Value::as_str) != Some("SYSTEM_MESSAGE") {
        return;
    }
    let Some(content) = step.get("content").and_then(Value::as_str) else {
        return;
    };
    if let Some((_, rest)) = content.split_once("sender=") {
        if let Some(id) = rest.split_whitespace().next() {
            heard.insert(id.to_string());
        }
    }
}

struct Child {
    card: String,
    map: UpdateMap,
    lines: usize,
    answer: String,
    transcript: Transcript,
    /// 最后一步是出错时，从什么时候开始没有进展。
    errored_at: Option<Instant>,
}

pub struct Subagents {
    project: PathBuf,
    parent: String,
    cards: HashMap<String, SubagentCard>,
    order: Vec<String>,
    children: HashMap<String, Child>,
    /// 不回放地接上时，只认这次连接之后的调用，避免认领历史子会话。
    first_step: u64,
    watching: bool,
    /// 这一回合派过子 Agent。
    invoked: bool,
}

impl Subagents {
    pub fn new(project: &Path) -> Self {
        Self {
            project: project.to_path_buf(),
            parent: String::new(),
            cards: HashMap::new(),
            order: Vec::new(),
            children: HashMap::new(),
            first_step: 0,
            watching: false,
            invoked: false,
        }
    }

    pub fn resume(&mut self, parent: &str, replay: bool) {
        self.parent = parent.to_string();
        if !replay {
            self.first_step = read_transcript(parent, 0)
                .into_iter().flat_map(|(steps, _)| steps)
                .filter_map(|step| step.get("step_index").and_then(Value::as_u64))
                .max().map_or(0, |step| step + 1);
        }
    }

    /// `invoke_subagent` 的更新。别的工具返回 None。
    pub fn apply(&mut self, session: &str, update: &Value) -> Option<Vec<SessionEventBody>> {
        if update.get("name").and_then(Value::as_str) != Some("invoke_subagent") {
            return None;
        }
        let id = update.get("toolCallId").and_then(Value::as_str)?.replace('\n', "-");
        self.parent = session.to_string();
        self.invoked = true;
        let input = update.get("rawInput").unwrap_or(&Value::Null);
        if !self.cards.contains_key(&id) {
            self.order.push(id.clone());
        }
        let card = self.cards.entry(id.clone()).or_insert_with(|| SubagentCard::new(&id, ""));
        if let Some(role) = text(input, "Role") {
            card.title = role;
        }
        if let Some(kind) = text(input, "TypeName") {
            card.agent_type = kind;
        }
        if let Some(prompt) = text(input, "Prompt") {
            card.prompt = prompt;
        }
        card.started_at.get_or_insert_with(now_millis);
        let status = update.get("status").and_then(Value::as_str).unwrap_or("");
        if status == "failed" {
            card.finish(SubagentStatus::Failed, Some(now_millis()));
        }
        let mut events = vec![SessionEventBody::Subagent(card.clone())];
        // 回放的调用一上来就是 completed，子 Agent 也早就跑完了，当场读完。
        if update.get("sessionUpdate").and_then(Value::as_str) == Some("tool_call") && status == "completed" {
            events.extend(self.poll());
        }
        Some(events)
    }

    pub fn needs_watch(&mut self) -> bool {
        if self.watching || !self.has_running() {
            return false;
        }
        self.watching = true;
        true
    }

    /// 这一回合派过子 Agent，或者还有子 Agent 在跑时返回主会话 id。
    pub fn awaited_parent(&mut self) -> Option<String> {
        let invoked = std::mem::take(&mut self.invoked);
        (invoked || self.has_running()).then(|| self.parent.clone())
    }

    /// 已经和卡片对上的子会话。
    pub fn child_ids(&self) -> Vec<String> {
        self.children.keys().cloned().collect()
    }

    pub fn has_running(&self) -> bool {
        self.cards.values().any(|card| card.status == SubagentStatus::Running)
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

    /// 读一遍磁盘：认领新出现的子会话，把转录里新增的步骤翻成事件。
    pub fn poll(&mut self) -> Vec<SessionEventBody> {
        let mut events = Vec::new();
        self.bind_children();
        let ids: Vec<String> = self.children.keys().cloned().collect();
        for child in ids {
            events.extend(self.read_child(&child));
        }
        events
    }

    fn bind_children(&mut self) {
        let Some(dir) = directory::brain_dir(&self.parent).map(|dir| dir.join(".system_generated").join("subagents")) else {
            return;
        };
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        // agy 1.5.4 实测：spawnStepIndex 是父转录里此调用的 GENERIC 结果步骤。
        // PLANNER_RESPONSE 的调用和随后 GENERIC 的次序相同，用完整调用输入关联 ACP 卡片。
        let calls = read_transcript(&self.parent, 0)
            .map(|(steps, _)| self.call_cards(spawn_calls(&steps))).unwrap_or_default();
        for entry in entries.filter_map(Result::ok) {
            let Some(id) = entry.path().file_stem().and_then(|stem| stem.to_str()).map(str::to_string) else {
                continue;
            };
            if self.children.contains_key(&id) {
                continue;
            }
            let Ok(record) = std::fs::read_to_string(entry.path()).map(|raw| serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null)) else {
                continue;
            };
            let Some(card) = record.get("spawnStepIndex").and_then(Value::as_u64).and_then(|step| calls.get(&step)) else {
                continue;
            };
            if self.cards[card].status == SubagentStatus::Running
                && !self.children.values().any(|child| &child.card == card)
            {
                self.bind(id, card.clone());
            }
        }
    }

    /// 先按转录次序固定调用和卡片，再找对应的子会话。缺一份记录也不能把后一个孩子移给前一张卡。
    fn call_cards(&self, calls: HashMap<u64, Value>) -> HashMap<u64, String> {
        let mut calls: Vec<_> = calls.into_iter().filter(|(step, _)| *step >= self.first_step).collect();
        calls.sort_by_key(|(step, _)| *step);
        let mut available = self.order.clone();
        let mut matched = HashMap::new();
        for (step, input) in calls {
            let (Some(role), Some(prompt), Some(kind)) = (text(&input, "Role"), text(&input, "Prompt"), text(&input, "TypeName")) else {
                continue;
            };
            if let Some(index) = available.iter().position(|id| {
                let card = &self.cards[id];
                card.title == role && card.prompt == prompt && card.agent_type == kind
            }) {
                matched.insert(step, available.remove(index));
            }
        }
        matched
    }

    fn bind(&mut self, child: String, card: String) {
        let mut map = UpdateMap::new(&self.project, &RULES);
        map.begin_turn(&format!("sub-{card}"));
        let tool = card.clone();
        self.children.insert(
            child,
            Child {
                card,
                map,
                lines: 0,
                answer: String::new(),
                transcript: Transcript::new(&tool),
                errored_at: None,
            },
        );
    }

    fn read_child(&mut self, id: &str) -> Vec<SessionEventBody> {
        let Some(seen) = self.children.get(id).map(|child| child.lines) else {
            return Vec::new();
        };
        let Some((steps, lines)) = read_transcript(id, seen) else {
            return Vec::new();
        };
        let mut events = Vec::new();
        for step in &steps {
            let out = self.children.get_mut(id).expect("known child").transcript.step(step);
            if let Some(answer) = out.answer.clone() {
                self.children.get_mut(id).expect("known child").answer = answer;
            }
            events.extend(self.child_updates(id, &out.updates));
            let child = self.children.get_mut(id).expect("known child");
            child.errored_at = out.errored.then(Instant::now);
            if out.finished {
                events.extend(self.finish(id, SubagentStatus::Completed));
            }
        }
        if let Some(child) = self.children.get_mut(id) {
            child.lines = lines.max(child.lines);
        }
        let gave_up = self.children.get(id).and_then(|child| child.errored_at).is_some_and(|at| at.elapsed() > ERROR_GRACE);
        if gave_up {
            events.extend(self.finish(id, SubagentStatus::Failed));
        }
        events
    }

    fn child_updates(&mut self, id: &str, updates: &[Value]) -> Vec<SessionEventBody> {
        let Some(child) = self.children.get_mut(id) else {
            return Vec::new();
        };
        let mut events = Vec::new();
        let mut card_changed = false;
        for update in updates {
            // 转录里每一步的回答单独成段。
            if update.get("sessionUpdate").and_then(Value::as_str) == Some("agent_message_chunk") {
                child.map.continue_turn();
            }
            for body in child.map.apply(update) {
                if let SessionEventBody::ToolCall { summary, status, .. } = &body {
                    if let Some(card) = self.cards.get_mut(&child.card) {
                        if *status == ToolStatus::Running && card.activity != *summary {
                            card.activity = summary.clone();
                            card_changed = true;
                        }
                    }
                }
                if matches!(
                    body,
                    SessionEventBody::AgentMessage { .. } | SessionEventBody::Thinking { .. } | SessionEventBody::ToolCall { .. }
                ) {
                    events.push(SessionEventBody::SubagentStep {
                        subagent_id: child.card.clone(),
                        step: Box::new(body),
                    });
                }
            }
        }
        if card_changed {
            if let Some(card) = self.cards.get(&child.card) {
                events.push(SessionEventBody::Subagent(card.clone()));
            }
        }
        events
    }

    fn finish(&mut self, id: &str, status: SubagentStatus) -> Vec<SessionEventBody> {
        let Some(child) = self.children.get(id) else {
            return Vec::new();
        };
        let Some(card) = self.cards.get_mut(&child.card) else {
            return Vec::new();
        };
        if card.status != SubagentStatus::Running {
            return Vec::new();
        }
        if !child.answer.is_empty() {
            card.result = child.answer.clone();
        }
        card.finish(status, Some(now_millis()));
        vec![SessionEventBody::Subagent(card.clone())]
    }
}

/// 子会话的生成步骤 → 派它的完整输入。不按角色或目录枚举顺序猜测。
fn spawn_calls(steps: &[Value]) -> HashMap<u64, Value> {
    let mut pending = VecDeque::new();
    let mut calls = HashMap::new();
    for step in steps {
        match step.get("type").and_then(Value::as_str) {
            Some("PLANNER_RESPONSE") => {
                for call in step.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
                    pending.push_back((call.get("name").and_then(Value::as_str), decoded_args(call.get("args"))));
                }
            }
            Some("GENERIC") => {
                if let Some((Some("invoke_subagent"), input)) = pending.pop_front() {
                    if let Some(index) = step.get("step_index").and_then(Value::as_u64) {
                        calls.insert(index, input);
                    }
                }
            }
            _ => {}
        }
    }
    calls
}

/// 子 Agent 还在跑时盯着磁盘。
pub fn watch(subagents: Arc<Mutex<Subagents>>, events: EventSink) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(POLL).await;
            let (fresh, running) = {
                let mut subagents = subagents.lock().unwrap();
                let fresh = subagents.poll();
                let running = subagents.has_running();
                if !running {
                    subagents.watching = false;
                }
                (fresh, running)
            };
            for event in fresh {
                let _ = events.send(event);
            }
            if !running || events.is_closed() {
                return;
            }
        }
    });
}

/// `args` 的值是 JSON 编码过的字符串，比如 `"\"a.txt\""`。
fn decoded_args(args: Option<&Value>) -> Value {
    let Some(args) = args.and_then(Value::as_object) else {
        return json!({});
    };
    Value::Object(
        args.iter()
            .map(|(key, value)| {
                let decoded = value
                    .as_str()
                    .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                    .unwrap_or_else(|| value.clone());
                (key.clone(), decoded)
            })
            .collect(),
    )
}

/// 工具结果开头的 `Created At: …` / `Completed At: …`。
fn strip_step_times(text: &str) -> String {
    let mut rest = text;
    for prefix in ["Created At:", "Completed At:"] {
        if rest.starts_with(prefix) {
            rest = rest.split_once('\n').map(|(_, tail)| tail).unwrap_or("");
        }
    }
    rest.to_string()
}

fn kind_of(name: &str) -> &'static str {
    match name {
        "read_file" | "view_file" | "list_dir" => "read",
        "edit_file" | "write_file" | "write_to_file" | "replace_file_content" | "multi_replace_file_content" | "sed_file" => "edit",
        "run_command" => "execute",
        "grep_search" | "find_by_name" => "search",
        "read_url_content" | "search_web" => "fetch",
        _ => "other",
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
