//! `session/update` → 时间线事件。实时回合和 `session/load` 的回放走同一份映射。
//!
//! 报文形状照 ACP（`@agentclientprotocol/sdk` 的 `SessionUpdate`）：
//! - 文字和思考是 `agent_message_chunk` / `agent_thought_chunk` 增量，中间夹着工具调用。
//! - `tool_call` 可能只有空 `rawInput`，`tool_call_update` 再补标题、输入、状态和结果。
//! - 编辑结果是 `content[].type = diff`。
//! - 回放里用户消息是 `user_message_chunk`。实时回合的同名更新是回显，由运行时丢掉。
//! - 后端出错时有的 Agent 不报错，而是发一段报错文字，`session/prompt` 照常 `end_turn`。
//!   这段先压着：后面还有内容就照常算回答，回合就此结束就算失败（[`UpdateMap::take_error`]）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{DiffTexts, ToolSubject, ToolView, UpdateRules};
use crate::changes::{same_file, unified_diff};
use aiwb_core::models::{
    FileChange, FileStatus, PlanStep, SessionEventBody, SessionStatus, ToolStatus,
};

struct Segment {
    id: String,
    text: String,
}

struct Tool {
    stream_id: String,
    kind: String,
    title: String,
    /// Agent 自己的工具名。Cursor 不给。
    native: String,
    input: Value,
    status: ToolStatus,
    exit_code: Option<i64>,
    detail: String,
    images: Vec<String>,
    name_override: Option<String>,
    summary_override: Option<String>,
}

/// 一个文件在这一轮里的最早原文和最新全文。多次编辑同一文件时 diff 从原文算起。
struct FileTexts {
    path: String,
    old: Option<String>,
    new: Option<String>,
}

pub struct UpdateMap {
    rules: &'static dyn UpdateRules,
    project: PathBuf,
    pub turn_id: String,
    pub plan_mode: bool,
    seq: u64,
    message: Option<Segment>,
    thought: Option<Segment>,
    /// 回放时连续的用户消息块，遇到别的更新再写出。
    user: Option<String>,
    replay_turns: u64,
    tools: HashMap<String, Tool>,
    files: Vec<FileTexts>,
    todos: Vec<(String, String, String)>,
    /// 最近一轮有变更时的统一 diff。
    pub last_diff: String,
    /// 压着没发的报错回答块。
    error_tail: Option<String>,
    /// 这一回合写出的计划正文。
    plan: Option<String>,
    /// 这一回合最后一段回答的原文。
    last_message: String,
}

impl UpdateMap {
    pub fn new(project: &Path, rules: &'static dyn UpdateRules) -> Self {
        Self {
            rules,
            project: project.to_path_buf(),
            turn_id: String::new(),
            plan_mode: false,
            seq: 0,
            message: None,
            thought: None,
            user: None,
            replay_turns: 0,
            tools: HashMap::new(),
            files: Vec::new(),
            todos: Vec::new(),
            last_diff: String::new(),
            error_tail: None,
            plan: None,
            last_message: String::new(),
        }
    }

    /// 这一回合写出的计划正文。读一次就清掉。
    pub fn take_plan(&mut self) -> Option<String> {
        self.plan.take()
    }

    pub fn last_message(&self) -> &str {
        &self.last_message
    }

    pub fn begin_turn(&mut self, turn_id: &str) {
        self.turn_id = turn_id.to_string();
        self.message = None;
        self.thought = None;
        self.error_tail = None;
        self.plan = None;
        self.last_message.clear();
        self.tools.clear();
        self.files.clear();
        self.todos.clear();
    }

    /// 引导继续同一个工作台回合：回答重新分段，文件差异仍从本回合最早原文累计。
    pub fn continue_turn(&mut self) {
        self.message = None;
        self.thought = None;
        self.error_tail = None;
    }

    /// 转成后台任务的命令跑完了：找到还在跑、命令相同的卡片，写上结果。
    pub fn finish_command(&mut self, command: &str, output: &str) -> Option<SessionEventBody> {
        let id = self
            .tools
            .iter()
            .find(|(_, tool)| {
                tool.status == ToolStatus::Running && tool.kind == "execute" && self.tool_summary(tool) == command
            })
            .map(|(id, _)| id.clone())?;
        let code = output
            .strip_prefix("Command exited with code ")
            .and_then(|rest| rest.split('.').next())
            .and_then(|code| code.trim().parse::<i64>().ok());
        let detail = self.rules.content_text(output);
        let tool = self.tools.get_mut(&id)?;
        tool.exit_code = code;
        tool.status = if code.is_some_and(|code| code != 0) { ToolStatus::Failed } else { ToolStatus::Completed };
        tool.detail = detail;
        Some(self.tool_event(&id))
    }

    /// 已确认取消后，把没有终态的工具卡片收尾。
    pub fn stop_tools(&mut self) -> Vec<SessionEventBody> {
        let mut ids = Vec::new();
        for (id, tool) in &mut self.tools {
            if tool.status == ToolStatus::Running {
                tool.status = ToolStatus::Failed;
                if !tool.detail.is_empty() { tool.detail.push('\n'); }
                tool.detail.push_str("已中断");
                ids.push(id.clone());
            }
        }
        ids.iter().map(|id| self.tool_event(id)).collect()
    }

    /// 取消的原生请求不会进入 Cursor 的下一轮上下文，保留已观察到的回答和工具结果。
    pub fn interrupted_context(&self) -> String {
        let mut parts = Vec::new();
        if let Some(message) = &self.message {
            parts.push(format!("Partial assistant response:\n{}", message.text));
        }
        let mut tools: Vec<_> = self.tools.iter().collect();
        tools.sort_by_key(|(id, _)| *id);
        for (_, tool) in tools {
            parts.push(format!("Observed tool: {}\nStatus: {:?}\n{}", self.tool_summary(tool), tool.status, tool.detail));
        }
        parts.join("\n\n")
    }

    /// 回合结束时还压着的报错：这一回合以它收尾，算失败。返回去掉 `Error: ` 的报错正文。
    pub fn take_error(&mut self) -> Option<String> {
        let tail = self.error_tail.take()?;
        Some(tail[self.rules.error_tail().len()..].trim().to_string())
    }

    /// 压着的报错后面还有内容：它只是回答的一部分，照常写出。
    fn release_error_tail(&mut self, events: &mut Vec<SessionEventBody>) {
        if let Some(text) = self.error_tail.take() {
            self.push_message(&text, events);
        }
    }

    fn push_message(&mut self, text: &str, events: &mut Vec<SessionEventBody>) {
        if self.message.is_none() {
            let id = self.next_id("msg");
            self.message = Some(Segment { id, text: String::new() });
        }
        let segment = self.message.as_mut().unwrap();
        segment.text.push_str(text);
        self.last_message.clone_from(&segment.text);
        events.push(SessionEventBody::AgentMessage {
            text: self.rules.message_view(&segment.text).into_owned(),
            stream_id: Some(segment.id.clone()),
            phase: None,
            mode: self.mode(),
            dedupe_of: None,
        });
    }

    /// 回放里一个回合收尾：以报错结束的记成失败。
    fn close_replay_turn(&mut self, events: &mut Vec<SessionEventBody>) {
        let status = match self.take_error() {
            Some(message) => {
                events.push(SessionEventBody::Error {
                    message: self.rules.error_message(&message),
                });
                SessionStatus::Failed
            }
            None => SessionStatus::Completed,
        };
        events.push(SessionEventBody::StatusChanged { status });
    }

    fn next_id(&mut self, prefix: &str) -> String {
        self.seq += 1;
        format!("{prefix}-{}-{}", self.turn_id, self.seq)
    }

    fn mode(&self) -> Option<String> {
        self.plan_mode.then(|| "plan".to_string())
    }

    /// 回放里攒着的用户消息写出去，并开一个新回合。前一回合按完成收尾。
    fn flush_user(&mut self, events: &mut Vec<SessionEventBody>) {
        let Some(text) = self.user.take() else {
            return;
        };
        if self.rules.hides_user_message(text.trim()) {
            return;
        }
        let text = strip_instructions(&text);
        let text = super::context::user_text(&text).to_string();
        if self.replay_turns > 0 {
            self.close_replay_turn(events);
        }
        self.replay_turns += 1;
        let turn_id = format!("replay-{}", uuid::Uuid::new_v4());
        self.begin_turn(&turn_id);
        events.push(SessionEventBody::UserMessage {
            text,
            images: Vec::new(),
            annotations: 0,
            sender: None,
        });
        events.push(SessionEventBody::TurnAnchor {
            turn_id,
            mode: self.mode(),
        });
    }

    /// 回放结束：写出最后一条用户消息，最后一个回合按完成收尾。
    pub fn finish_replay(&mut self) -> Vec<SessionEventBody> {
        let mut events = Vec::new();
        self.flush_user(&mut events);
        if self.replay_turns > 0 {
            self.close_replay_turn(&mut events);
        }
        self.replay_turns = 0;
        events
    }

    pub fn apply(&mut self, update: &Value) -> Vec<SessionEventBody> {
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut events = Vec::new();
        if kind != "user_message_chunk" {
            self.flush_user(&mut events);
        }
        let text = content_text(update.get("content"));
        let error = kind == "agent_message_chunk" && text.as_deref().is_some_and(|text| text.starts_with(self.rules.error_tail()));
        if !error && matches!(kind, "agent_message_chunk" | "agent_thought_chunk" | "tool_call" | "tool_call_update" | "plan") {
            self.release_error_tail(&mut events);
        }
        match kind {
            "agent_message_chunk" if error => {
                self.thought = None;
                self.error_tail = text;
            }
            "user_message_chunk" => {
                if let Some(text) = content_text(update.get("content")) {
                    self.user.get_or_insert_with(String::new).push_str(&text);
                }
            }
            "agent_message_chunk" => {
                self.thought = None;
                if let Some(text) = text {
                    self.push_message(&text, &mut events);
                }
            }
            "agent_thought_chunk" => {
                self.message = None;
                if let Some(text) = content_text(update.get("content")) {
                    if self.thought.is_none() {
                        let id = self.next_id("think");
                        self.thought = Some(Segment { id, text: String::new() });
                    }
                    let segment = self.thought.as_mut().unwrap();
                    segment.text.push_str(&text);
                    events.push(SessionEventBody::Thinking {
                        text: segment.text.clone(),
                        stream_id: Some(segment.id.clone()),
                    });
                }
            }
            "tool_call" | "tool_call_update" => {
                self.message = None;
                self.thought = None;
                events.extend(self.on_tool(update, kind == "tool_call"));
            }
            "plan" => {
                let steps = update
                    .get("entries")
                    .and_then(Value::as_array)
                    .map(|entries| {
                        entries
                            .iter()
                            .filter_map(|entry| {
                                let step = entry.get("content").and_then(Value::as_str)?.trim();
                                (!step.is_empty()).then(|| PlanStep {
                                    step: step.to_string(),
                                    status: step_status(
                                        entry.get("status").and_then(Value::as_str).unwrap_or(""),
                                    ),
                                })
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                events.push(SessionEventBody::PlanSteps {
                    turn_id: self.turn_id.clone(),
                    explanation: String::new(),
                    steps,
                    mode: self.mode(),
                });
            }
            "current_mode_update" => {
                let plan = update.get("currentModeId").and_then(Value::as_str) == Some("plan");
                if plan != self.plan_mode {
                    self.plan_mode = plan;
                    events.push(SessionEventBody::CollaborationMode {
                        mode: if plan { "plan" } else { "default" }.into(),
                    });
                }
            }
            _ => {}
        }
        events
    }

    /// `cursor/update_todos`：`merge` 时按 id 更新已有条目，否则整份替换。
    pub fn apply_todos(&mut self, params: &Value) -> Vec<SessionEventBody> {
        let incoming: Vec<(String, String, String)> = params
            .get("todos")
            .and_then(Value::as_array)
            .map(|todos| {
                todos
                    .iter()
                    .filter_map(|todo| {
                        let id = todo.get("id").and_then(Value::as_str)?.to_string();
                        let content = todo.get("content").and_then(Value::as_str)?.to_string();
                        let status = todo.get("status").and_then(Value::as_str).unwrap_or("pending");
                        Some((id, content, status.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if params.get("merge").and_then(Value::as_bool).unwrap_or(false) {
            for item in incoming {
                match self.todos.iter_mut().find(|todo| todo.0 == item.0) {
                    Some(slot) => *slot = item,
                    None => self.todos.push(item),
                }
            }
        } else {
            self.todos = incoming;
        }
        vec![self.todo_steps()]
    }

    pub fn todo_steps(&self) -> SessionEventBody {
        SessionEventBody::PlanSteps {
            turn_id: self.turn_id.clone(),
            explanation: String::new(),
            steps: self
                .todos
                .iter()
                .map(|(_, content, status)| PlanStep {
                    step: content.clone(),
                    status: step_status(status),
                })
                .collect(),
            mode: self.mode(),
        }
    }

    pub fn set_todos(&mut self, todos: &Value) {
        self.todos.clear();
        self.apply_todos(&serde_json::json!({ "todos": todos }));
    }

    /// `cursor/generate_image`：把生成图挂到对应的工具卡上。
    pub fn attach_image(&mut self, params: &Value) -> Vec<SessionEventBody> {
        let id = params.get("toolCallId").and_then(Value::as_str).unwrap_or("");
        let path = params
            .get("filePath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty());
        let description = params
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let Some(tool) = self.tools.get_mut(id) else {
            return Vec::new();
        };
        tool.name_override = Some("image_generation".into());
        if !description.is_empty() {
            tool.summary_override = Some(description);
        }
        if let Some(path) = path {
            if !tool.images.iter().any(|item| item == path) {
                tool.images.push(path.to_string());
            }
        }
        vec![self.tool_event(id)]
    }

    fn on_tool(&mut self, update: &Value, created: bool) -> Vec<SessionEventBody> {
        let Some(id) = update.get("toolCallId").and_then(Value::as_str) else {
            return Vec::new();
        };
        let view = self.rules.tool_view(update);
        let counts = matches!(view, ToolView::Card);
        match view {
            ToolView::Hidden => return Vec::new(),
            ToolView::Plan { text } => {
                self.plan = Some(text.clone());
                return vec![SessionEventBody::PlanText {
                    text,
                    stream_id: Some(format!("plan-{id}")),
                    mode: self.mode(),
                }];
            }
            ToolView::Steps(steps) => {
                return vec![SessionEventBody::PlanSteps {
                    turn_id: self.turn_id.clone(),
                    explanation: String::new(),
                    steps,
                    mode: self.mode(),
                }];
            }
            ToolView::Card | ToolView::Artifact => {}
        }
        if created || !self.tools.contains_key(id) {
            let stream_id = format!("tool-{}", id.replace('\n', "-"));
            self.tools.insert(
                id.to_string(),
                Tool {
                    stream_id,
                    kind: String::new(),
                    title: String::new(),
                    native: String::new(),
                    input: Value::Null,
                    status: ToolStatus::Running,
                    exit_code: None,
                    detail: String::new(),
                    images: Vec::new(),
                    name_override: None,
                    summary_override: None,
                },
            );
        }
        let mut diffs = Vec::new();
        {
            let tool = self.tools.get_mut(id).unwrap();
            if let Some(kind) = update.get("kind").and_then(Value::as_str) {
                tool.kind = kind.to_string();
            }
            if let Some(title) = update.get("title").and_then(Value::as_str) {
                tool.title = title.to_string();
            }
            if let Some(native) = update.get("name").and_then(Value::as_str) {
                tool.native = native.to_string();
            }
            if let Some(input) = update.get("rawInput").filter(|input| non_empty(input)) {
                tool.input = input.clone();
            }
            if let Some(status) = update.get("status").and_then(Value::as_str) {
                tool.status = match status {
                    "completed" => ToolStatus::Completed,
                    "failed" => ToolStatus::Failed,
                    _ => ToolStatus::Running,
                };
            }
            let mut detail = Vec::new();
            if let Some(output) = update.get("rawOutput").filter(|output| non_empty(output)) {
                if let Some(code) = self.rules.exit_code(output) {
                    tool.exit_code = Some(code);
                    if code != 0 {
                        tool.status = ToolStatus::Failed;
                    }
                }
                detail.push(self.rules.tool_output(output));
            }
            if let Some(content) = update.get("content").and_then(Value::as_array) {
                for item in content {
                    match item.get("type").and_then(Value::as_str) {
                        Some("diff") => {
                            if let Some(change) = self.rules.diff_texts(item).map(file_texts) {
                                let path = relative(&self.project, &self.rules.path(&change.path));
                                detail.push(unified_diff(
                                    &path,
                                    change.old.as_deref().unwrap_or(""),
                                    change.new.as_deref().unwrap_or(""),
                                ));
                                diffs.push(change);
                            }
                        }
                        Some("content") => {
                            if let Some(text) = content_text(item.get("content")) {
                                let text = self.rules.content_text(&text);
                                if !detail.contains(&text) {
                                    detail.push(text);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            let detail: Vec<String> = detail
                .into_iter()
                .filter(|text| !text.trim().is_empty())
                .collect();
            if !detail.is_empty() {
                tool.detail = detail.join("\n");
                for image in self.rules.tool_images(&tool.detail) {
                    if !tool.images.contains(&image) {
                        tool.images.push(image);
                    }
                }
            }
        }
        let mut events = vec![self.tool_event(id)];
        if counts && !diffs.is_empty() {
            events.extend(self.record_files(diffs));
        }
        events
    }

    fn tool_event(&self, id: &str) -> SessionEventBody {
        let tool = &self.tools[id];
        SessionEventBody::ToolCall {
            name: tool
                .name_override
                .clone()
                .unwrap_or_else(|| self.rules.tool_name(&tool.kind, &tool.title, &tool.native)),
            summary: tool
                .summary_override
                .clone()
                .unwrap_or_else(|| self.tool_summary(tool)),
            detail: tool.detail.clone(),
            stream_id: Some(tool.stream_id.clone()),
            images: tool.images.clone(),
            status: tool.status,
            exit_code: tool.exit_code,
        }
    }

    fn tool_summary(&self, tool: &Tool) -> String {
        match self.rules.tool_subject(&tool.kind, &tool.input) {
            Some(ToolSubject::Path(path)) => self.relative(&path),
            Some(ToolSubject::Text(text)) => text,
            None => strip_ticks(&tool.title),
        }
    }

    fn relative(&self, path: &str) -> String {
        relative(&self.project, &self.rules.path(path))
    }

    /// 项目里的文件按相对路径记，和 git 范围的路径对得上。
    fn record_files(&mut self, diffs: Vec<FileTexts>) -> Vec<SessionEventBody> {
        for mut change in diffs {
            change.path = self.relative(&change.path);
            match self
                .files
                .iter_mut()
                .find(|file| same_file(&file.path, &change.path))
            {
                Some(slot) => slot.new = change.new,
                None => self.files.push(change),
            }
        }
        let files: Vec<FileChange> = self.files.iter().map(file_change).collect();
        let mut events = Vec::new();
        for file in &files {
            events.push(SessionEventBody::FileChange {
                turn_id: self.turn_id.clone(),
                path: file.path.clone(),
                status: file.status,
                added: file.added,
                removed: file.removed,
                diff: file.diff.clone(),
            });
        }
        let diff = files
            .iter()
            .map(|file| file.diff.clone())
            .collect::<Vec<_>>()
            .join("\n");
        self.last_diff = diff.clone();
        events.push(SessionEventBody::TurnDiff {
            turn_id: self.turn_id.clone(),
            diff,
        });
        events.push(SessionEventBody::TurnChanges {
            turn_id: self.turn_id.clone(),
            files,
        });
        events
    }
}

const INSTRUCTIONS_OPEN: &str = "<aiwb_instructions>\n";
const INSTRUCTIONS_CLOSE: &str = "\n</aiwb_instructions>";

/// 跟着第一条提示送给 Cursor 的工作台说明，单独一块。
pub fn wrap_instructions(text: &str) -> String {
    format!("{INSTRUCTIONS_OPEN}{text}{INSTRUCTIONS_CLOSE}")
}

/// 回放的用户消息里去掉工作台说明，只留用户写的。
fn strip_instructions(text: &str) -> String {
    match text.strip_prefix(INSTRUCTIONS_OPEN).and_then(|rest| rest.split_once(INSTRUCTIONS_CLOSE)) {
        Some((_, user)) => user.trim_start().to_string(),
        None => text.to_string(),
    }
}

fn relative(project: &Path, path: &str) -> String {
    Path::new(path)
        .strip_prefix(project)
        .map(|rest| rest.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string())
}

fn file_change(file: &FileTexts) -> FileChange {
    let diff = unified_diff(
        &file.path,
        file.old.as_deref().unwrap_or(""),
        file.new.as_deref().unwrap_or(""),
    );
    let (added, removed) = count_lines(&diff);
    let status = match (&file.old, &file.new) {
        (None, _) => FileStatus::Added,
        (_, None) => FileStatus::Deleted,
        _ => FileStatus::Modified,
    };
    FileChange {
        path: file.path.clone(),
        status,
        added,
        removed,
        diff,
    }
}

/// 数 `+` / `-` 行，跳过文件头。Windows 路径带冒号，diffy 解析不了这样的文件头。
fn count_lines(diff: &str) -> (u32, u32) {
    let mut added = 0u32;
    let mut removed = 0u32;
    for line in diff.lines() {
        if line.starts_with("+++ ") || line.starts_with("--- ") {
            continue;
        }
        if line.starts_with('+') {
            added += 1;
        } else if line.starts_with('-') {
            removed += 1;
        }
    }
    (added, removed)
}

fn file_texts(diff: DiffTexts) -> FileTexts {
    FileTexts {
        path: diff.path,
        old: diff.old,
        new: diff.new,
    }
}

/// 时间线按名字认命令。其余用 ACP 的 `kind`，再不行用标题。
pub fn tool_name(kind: &str, title: &str) -> String {
    match kind {
        "execute" => "command".into(),
        "edit" => "Edit".into(),
        "delete" => "Delete".into(),
        "move" => "Move".into(),
        "read" => "Read".into(),
        "search" => "Search".into(),
        "fetch" => "WebFetch".into(),
        _ => {
            let title = strip_ticks(title);
            if title.is_empty() {
                "工具调用".into()
            } else {
                title
            }
        }
    }
}

pub fn strip_ticks(text: &str) -> String {
    let trimmed = text.trim();
    trimmed
        .strip_prefix('`')
        .and_then(|rest| rest.strip_suffix('`'))
        .unwrap_or(trimmed)
        .to_string()
}

/// ACP 计划和各 Agent 待办的状态 → 时间线计划步骤的状态。
pub fn step_status(status: &str) -> String {
    match status {
        "in_progress" | "inProgress" => "inProgress".into(),
        "completed" => "completed".into(),
        "cancelled" => "cancelled".into(),
        _ => "pending".into(),
    }
}

pub fn content_text(content: Option<&Value>) -> Option<String> {
    let content = content?;
    if content.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }
    content
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn non_empty(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Object(map) => !map.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

pub fn output_text(output: &Value) -> String {
    let stdout = output.get("stdout").and_then(Value::as_str);
    let stderr = output.get("stderr").and_then(Value::as_str);
    if stdout.is_some() || stderr.is_some() {
        return [stdout.unwrap_or(""), stderr.unwrap_or("")]
            .iter()
            .map(|text| text.trim_end())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
    }
    // 读文件的结果是 `{content: "<全文>"}`。
    if let Some(content) = output.get("content").and_then(Value::as_str) {
        return content.to_string();
    }
    match output {
        Value::String(text) => text.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}
