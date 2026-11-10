//! Antigravity 在 ACP 之上的差别。证据来自 2026-11-09 本机 agy 1.5.3 的实际收发：
//! - `tool_call` 带 Agent 自己的工具名 `name`，`rawInput` 的键是大驼峰（`Path`、`CommandLine`）。
//! - 路径写成 `/C:/Users/…`。
//! - diff 的 `oldText` / `newText` 比文件多一个结尾换行。
//! - 命令结果在 `rawOutput.output`，同一段文字也在 `content[]`，开头是 `Command exited with code N.`。
//! - 计划和待办是写进 `brain/<会话>/` 的产物（`implementation_plan.md`、`task.md`），不是项目改动。
//! - 回合进行中再发 `session/prompt` 就是引导：前一个 prompt 马上以 `end_turn` 回包，后一个接着这一回合。
//! - 取消的回合还留在会话历史里。
//! - 后端出错时发一段 `⚠ Agent execution terminated due to error.` 的回答文字，`stopReason` 仍是 `end_turn`。
//! - `/goal` 是一段提示模板：达成时回答里带 `<!-- GOAL_COMPLETE -->`，放弃时带 `<!-- GOAL_CANCELLED -->`。

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{json, Value};

use super::catalog;
use super::directory;
use super::elicitation;
use super::open;
use super::permission;
use super::subagents::{self, ParentTail, Subagents};
use crate::acp::queue::Input;
use crate::acp::runtime::Shared;
use crate::acp::{Dialect, DiffTexts, PendingAnswer, ToolSubject, ToolView, UpdateRules};
use crate::protocol::plan_choice::{
    classify_plan_answer, plan_implementation_options, PlanChoice, CLEAR_CONTEXT_ID, IMPLEMENT_ID,
    PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX, PLAN_IMPLEMENTATION_CODING_MESSAGE, PLAN_IMPLEMENTATION_TITLE,
};
use crate::{AgentError, EventSink, UserTurn};
use aiwb_core::models::{
    AgentCatalog, PermissionMenu, PlanStep, PromptAnswer, PromptKind, SessionEventBody, SessionStatus,
};

pub struct AntigravityRules;

pub static RULES: AntigravityRules = AntigravityRules;

const ERROR_TAIL: &str = "\n⚠ Agent execution terminated due to error.\n";
const GOAL_COMPLETE: &str = "<!-- GOAL_COMPLETE -->";
const GOAL_CANCELLED: &str = "<!-- GOAL_CANCELLED -->";
const PLAN_ARTIFACT: &str = "implementation_plan.md";
const TASK_ARTIFACT: &str = "task.md";

impl UpdateRules for AntigravityRules {
    fn error_tail(&self) -> &'static str {
        ERROR_TAIL
    }

    fn error_message(&self, detail: &str) -> String {
        if detail.is_empty() {
            "Antigravity 这一轮因错误中止。".into()
        } else {
            format!("Antigravity 出错：{detail}")
        }
    }

    fn message_view<'a>(&self, text: &'a str) -> Cow<'a, str> {
        if text.contains(GOAL_COMPLETE) || text.contains(GOAL_CANCELLED) {
            Cow::Owned(
                text.replace(GOAL_COMPLETE, "")
                    .replace(GOAL_CANCELLED, "")
                    .trim_end()
                    .to_string(),
            )
        } else {
            Cow::Borrowed(text)
        }
    }

    fn path(&self, raw: &str) -> String {
        let bytes = raw.as_bytes();
        // `/C:/Users/…` → `C:/Users/…`。
        if bytes.len() > 3 && bytes[0] == b'/' && bytes[2] == b':' && bytes[1].is_ascii_alphabetic() {
            raw[1..].to_string()
        } else {
            raw.to_string()
        }
    }

    fn diff_texts(&self, item: &Value) -> Option<DiffTexts> {
        let path = self.path(item.get("path").and_then(Value::as_str)?.trim());
        if path.is_empty() {
            return None;
        }
        let text = |key: &str| {
            item.get(key)
                .and_then(Value::as_str)
                .map(|text| text.strip_suffix('\n').unwrap_or(text).to_string())
        };
        Some(DiffTexts { path, old: text("oldText"), new: text("newText") })
    }

    fn tool_view(&self, update: &Value) -> ToolView {
        if update.get("name").and_then(Value::as_str) == Some("ask_question") {
            return ToolView::Hidden;
        }
        if update.get("kind").and_then(Value::as_str) != Some("edit") {
            return ToolView::Card;
        }
        let input = update.get("rawInput").unwrap_or(&Value::Null);
        let Some(path) = file_field(input).filter(|path| directory::is_artifact(path)) else {
            return ToolView::Card;
        };
        let name = path.replace('\\', "/").rsplit('/').next().unwrap_or("").to_string();
        if name != PLAN_ARTIFACT && name != TASK_ARTIFACT {
            return ToolView::Artifact;
        }
        let written = final_text(update, input);
        match (name.as_str(), written) {
            (PLAN_ARTIFACT, Some(text)) if !text.trim().is_empty() => ToolView::Plan { text },
            (TASK_ARTIFACT, Some(text)) => ToolView::Steps(task_steps(&text)),
            _ => ToolView::Hidden,
        }
    }

    fn tool_name(&self, kind: &str, title: &str, native: &str) -> String {
        match kind {
            "execute" | "edit" | "delete" | "move" | "read" | "search" | "fetch" => {
                crate::acp::updates::tool_name(kind, title)
            }
            _ if native == "generate_image" => "image_generation".into(),
            _ => mcp_name(native).unwrap_or_else(|| {
                if native.is_empty() {
                    crate::acp::updates::tool_name(kind, title)
                } else {
                    native.to_string()
                }
            }),
        }
    }

    fn tool_subject(&self, kind: &str, input: &Value) -> Option<ToolSubject> {
        let field = |keys: &[&str]| {
            keys.iter()
                .find_map(|key| input.get(*key).and_then(Value::as_str))
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        };
        match kind {
            "execute" => field(&["CommandLine"]).map(ToolSubject::Text),
            "edit" | "read" | "delete" | "move" => file_field(input).map(ToolSubject::Path),
            "search" => field(&["Query", "Pattern", "SearchPattern", "SearchTerm"]).map(ToolSubject::Text),
            "fetch" => field(&["Url", "Query"]).map(ToolSubject::Text),
            _ => field(&["toolSummary"]).map(ToolSubject::Text),
        }
    }

    fn hides_user_message(&self, text: &str) -> bool {
        text == NUDGE
    }

    fn tool_output(&self, output: &Value) -> String {
        output
            .get("output")
            .and_then(Value::as_str)
            .map(command_body)
            .unwrap_or_default()
    }

    fn content_text(&self, text: &str) -> String {
        command_body(text)
    }

    /// `generate_image` 的结果：`Generated image is saved at <路径>.`
    fn tool_images(&self, detail: &str) -> Vec<String> {
        detail
            .lines()
            .filter_map(|line| line.trim().strip_prefix("Generated image is saved at "))
            .map(|path| path.trim_end_matches('.').to_string())
            .collect()
    }

    fn exit_code(&self, output: &Value) -> Option<i64> {
        output.get("exit_code").and_then(Value::as_i64)
    }
}

fn file_field(input: &Value) -> Option<String> {
    ["Path", "TargetFile", "AbsolutePath", "FilePath", "DirectoryPath"]
        .iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string)
}

/// 编辑完成后的全文在 diff 里；整份写入时输入里也有。
fn final_text(update: &Value, input: &Value) -> Option<String> {
    update
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|item| item.get("type").and_then(Value::as_str) == Some("diff"))
        .and_then(|item| RULES.diff_texts(item))
        .and_then(|diff| diff.new)
        .or_else(|| input.get("Content").and_then(Value::as_str).map(str::to_string))
}

/// `task.md` 的勾选清单：`[ ]` 待做，`[/]` 进行中，`[x]` 完成。
pub fn task_steps(text: &str) -> Vec<PlanStep> {
    text.lines()
        .filter_map(|line| {
            let rest = line.trim_start().strip_prefix("- [")?;
            let (mark, step) = rest.split_once(']')?;
            let step = step.trim();
            if step.is_empty() {
                return None;
            }
            let status = match mark.trim() {
                "x" | "X" => "completed",
                "/" => "inProgress",
                _ => "pending",
            };
            Some(PlanStep { step: step.to_string(), status: status.to_string() })
        })
        .collect()
}

/// `Command exited with code N.\n\nCommand output:\n…` 只留输出。
fn command_body(text: &str) -> String {
    let Some(rest) = text.strip_prefix("Command exited with code ") else {
        return text.to_string();
    };
    let Some((_, rest)) = rest.split_once(".\n\n") else {
        return text.to_string();
    };
    match rest.strip_prefix("Command output:\n") {
        Some(body) => body.trim_end().to_string(),
        None if rest.trim() == "No output from the command." => String::new(),
        None => rest.to_string(),
    }
}

/// `mcp_<服务>_<工具>` → 时间线认的 `mcp__<服务>__<工具>`。服务名里的下划线分不开，算到工具名里。
fn mcp_name(native: &str) -> Option<String> {
    let (server, tool) = native.strip_prefix("mcp_")?.split_once('_')?;
    Some(format!("mcp__{server}__{tool}"))
}

/// `session/prompt` 回包之后主会话继续做的事，下一条消息开始时才从 ACP 冲出来
/// （2026-11-09 agy 1.5.3：子 Agent 跑完唤醒主会话，回答要等下一个 prompt 才推送）。
/// 这段已经从转录显示过了：文字冲出来时跳过，工具更新换成已显示卡片的 id 接着更新。
#[derive(Default)]
struct Shown {
    text: String,
    tools: Vec<(String, Value, String)>,
    ids: HashMap<String, String>,
}

impl Shown {
    fn record(&mut self, update: &Value) {
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk") => {
                if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
                    self.text.push_str(text);
                }
            }
            Some("tool_call") => {
                let name = update.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                let id = update.get("toolCallId").and_then(Value::as_str).unwrap_or("").to_string();
                self.tools.push((name, update.get("rawInput").cloned().unwrap_or(Value::Null), id));
            }
            _ => {}
        }
    }

    /// 显示过的工具调用再次出现时，返回换成卡片 id 的更新。
    fn rewrite(&mut self, update: &Value) -> Option<Value> {
        if !matches!(update.get("sessionUpdate").and_then(Value::as_str), Some("tool_call" | "tool_call_update")) {
            return None;
        }
        let id = update.get("toolCallId").and_then(Value::as_str)?.to_string();
        let shown = match self.ids.get(&id) {
            Some(shown) => shown.clone(),
            None => {
                let name = update.get("name").and_then(Value::as_str).unwrap_or("");
                let input = update.get("rawInput").unwrap_or(&Value::Null);
                let index = self.tools.iter().position(|(tool, seen, _)| tool == name && seen == input)?;
                let (_, _, shown) = self.tools.remove(index);
                self.ids.insert(id, shown.clone());
                shown
            }
        };
        let mut rewritten = update.clone();
        rewritten["toolCallId"] = json!(shown);
        Some(rewritten)
    }

    /// 这段文字是不是显示过的。一对不上就说明冲完了。
    fn absorbs(&mut self, update: &Value) -> bool {
        if self.text.is_empty() {
            return false;
        }
        match update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("") {
            "agent_thought_chunk" => true,
            "agent_message_chunk" => {
                let chunk = update.pointer("/content/text").and_then(Value::as_str).unwrap_or("");
                match self.text.strip_prefix(chunk) {
                    Some(rest) => {
                        self.text = rest.to_string();
                        true
                    }
                    None => {
                        self.text.clear();
                        false
                    }
                }
            }
            _ => false,
        }
    }
}

/// 子 Agent 都结束后，等主会话回话最多这么久。
const PARENT_REPLY: Duration = Duration::from_secs(60);
const PARENT_POLL: Duration = Duration::from_millis(300);
/// 主会话的工具调用这么久没有进展，就当它在等审批。
const TOOL_STALL: Duration = Duration::from_secs(3);

/// 回包之后主会话要审批的工具不会发 `session/request_permission`，等下一个 prompt 才放出来，
/// 所以发一条接回回合。回放时不算用户消息。
pub const NUDGE: &str = "Continue with the current task.";

struct Goal {
    objective: String,
    status: String,
}

pub struct AntigravityDialect {
    subagents: Arc<Mutex<Subagents>>,
    events: EventSink,
    goal: Mutex<Option<Goal>>,
    shown: Mutex<Shown>,
    /// 只为探模型目录建的会话，进程退出后删掉。
    probing: bool,
    servers: Value,
}

impl AntigravityDialect {
    pub fn new(project: &std::path::Path, events: EventSink, probing: bool, servers: Value) -> Self {
        Self {
            subagents: Arc::new(Mutex::new(Subagents::new(project))),
            events,
            goal: Mutex::new(None),
            shown: Mutex::new(Shown::default()),
            probing,
            servers,
        }
    }

    fn goal_event(&self) -> SessionEventBody {
        let goal = self.goal.lock().unwrap();
        SessionEventBody::Goal {
            objective: goal.as_ref().map(|goal| goal.objective.clone()),
            status: goal.as_ref().map(|goal| goal.status.clone()),
            token_budget: None,
            tokens_used: None,
            time_used_seconds: None,
        }
    }

    fn publish(&self) {
        let _ = self.events.send(self.goal_event());
    }

    fn set_goal_state(&self, objective: &str, status: &str) {
        *self.goal.lock().unwrap() = Some(Goal { objective: objective.to_string(), status: status.to_string() });
        self.publish();
    }

    fn clear_goal_state(&self) {
        *self.goal.lock().unwrap() = None;
        self.publish();
    }

    fn update_goal(&self, last_message: &str, status: SessionStatus) {
        let current = self.goal.lock().unwrap().as_ref().map(|goal| goal.objective.clone());
        let Some(objective) = current else {
            return;
        };
        if last_message.contains(GOAL_CANCELLED) {
            self.clear_goal_state();
        } else if last_message.contains(GOAL_COMPLETE) {
            self.set_goal_state(&objective, "complete");
        } else if matches!(status, SessionStatus::Stopped | SessionStatus::Failed) {
            self.set_goal_state(&objective, "paused");
        }
    }

    /// 派子 Agent 的工具调用归卡片，不进主时间线。
    fn absorb_subagent(&self, parent: &str, update: &Value) -> Option<Vec<SessionEventBody>> {
        let mut subagents = self.subagents.lock().unwrap();
        let events = subagents.apply(parent, update)?;
        if subagents.needs_watch() {
            subagents::watch(self.subagents.clone(), self.events.clone());
        }
        Some(events)
    }

    fn offer_plan(&self, shared: &Arc<Shared>, plan: String) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let prompt_id = format!("implement-plan-{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
        let event = SessionEventBody::Prompt {
            prompt_id: prompt_id.clone(),
            prompt_kind: PromptKind::Choice,
            question: PLAN_IMPLEMENTATION_TITLE.to_string(),
            options: plan_implementation_options(Some(&plan), None),
            questions: Vec::new(),
            header: String::new(),
            subtitle: String::new(),
            body: String::new(),
            body_kind: String::new(),
            reason: String::new(),
        };
        shared.raise_local(prompt_id, Arc::new(PlanOffer { plan }), event);
    }
}

#[async_trait]
impl Dialect for AntigravityDialect {
    fn label(&self) -> &'static str {
        "Antigravity"
    }

    fn rules(&self) -> &'static dyn UpdateRules {
        &RULES
    }

    fn not_logged_in(&self) -> String {
        "Antigravity 还没有登录。请在终端运行 `agy` 登录后再试。".into()
    }

    fn access_level(&self, mode: &str) -> &'static str {
        match mode {
            "full" => "full",
            "approve-for-me" => "approve-for-me",
            _ => "ask",
        }
    }

    fn permission_menu(&self, active: &str) -> PermissionMenu {
        permission::permission_menu(active)
    }

    fn mode_id(&self, plan: bool, access: &str) -> &'static str {
        if plan {
            "plan"
        } else if access == "approve-for-me" {
            "accept-edits"
        } else {
            "default"
        }
    }

    fn steers_in_place(&self) -> bool {
        true
    }

    fn keeps_cancelled_turns(&self) -> bool {
        true
    }

    fn asks_user(&self, method: &str) -> bool {
        matches!(method, "session/request_permission" | "elicitation/create")
    }

    fn cancelled_reply(&self, method: &str) -> Value {
        if method == "elicitation/create" {
            elicitation::cancelled()
        } else {
            crate::acp::permission::cancelled()
        }
    }

    fn workbench_tool(&self, params: &Value) -> bool {
        let name = params.pointer("/toolCall/name").and_then(Value::as_str).unwrap_or("");
        name.starts_with(&format!("mcp_{}_aiwb_", crate::WorkbenchMcp::SERVER_NAME))
    }

    fn on_request(&self, shared: &Shared, id: &Value, method: &str, params: &Value) -> bool {
        if method != "elicitation/create" {
            return false;
        }
        let prompt_id = crate::acp::permission::prompt_id(id);
        let (event, pending) = elicitation::question_prompt(&prompt_id, params);
        shared.raise(id.clone(), prompt_id, Arc::new(pending), vec![event]);
        true
    }

    fn on_update(&self, session: &str, update: &Value) -> Option<Vec<SessionEventBody>> {
        if self.shown.lock().unwrap().absorbs(update) {
            return Some(Vec::new());
        }
        self.absorb_subagent(session, update)
    }

    fn rewrite_update(&self, update: &Value) -> Option<Value> {
        self.shown.lock().unwrap().rewrite(update)
    }

    fn adopt_session(&self, catalog: &mut AgentCatalog, payload: &Value) {
        catalog::apply_session(catalog, payload);
    }

    fn stop_extras(&self) -> Vec<SessionEventBody> {
        self.subagents.lock().unwrap().stop_all()
    }

    /// 被后一个 prompt 接管的回包没有 `usage`。
    fn turn_reply(&self, shared: &Shared, reply: &Value) -> Vec<SessionEventBody> {
        let Some(usage) = reply.get("usage") else {
            return Vec::new();
        };
        let tokens = |key: &str| usage.get(key).and_then(Value::as_i64);
        let turn_id = shared.map.lock().unwrap().turn_id.clone();
        let cached = tokens("cachedReadTokens");
        let input = tokens("inputTokens");
        vec![
            SessionEventBody::ContextUsage {
                source: "partial-usage".into(),
                used_tokens: None,
                max_tokens: None,
                percentage: None,
                input_tokens: input.map(|input| input + cached.unwrap_or(0)),
                output_tokens: tokens("outputTokens"),
                model: None,
            },
            SessionEventBody::SessionUsage {
                scope: "delta".into(),
                key: Some(turn_id),
                input_tokens: input,
                output_tokens: tokens("outputTokens"),
                cache_read_tokens: cached,
                cache_write_tokens: tokens("cachedWriteTokens"),
            },
        ]
    }

    /// 主会话派完子 Agent、或者命令转成后台任务后就空闲，`session/prompt` 跟着回包。它们结束时唤醒主会话，
    /// 这时已经没有 prompt 在等，所以回合继续算运行中，从转录里把后面的回答接上，直到它回完话。
    async fn settle_turn(&self, shared: &Arc<Shared>) {
        let Some(parent) = shared.session_id() else {
            return;
        };
        let awaited = self.subagents.lock().unwrap().awaited_parent().is_some();
        let mut tail = ParentTail::new(&parent);
        if !awaited && !tail.waiting_on_tasks() {
            return;
        }
        let mut quiet_since: Option<Instant> = None;
        let mut progressed = Instant::now();
        loop {
            if shared.closed.load(std::sync::atomic::Ordering::SeqCst)
                || shared.user_stopped.load(std::sync::atomic::Ordering::SeqCst)
                || shared.has_steered()
            {
                return;
            }
            let updates = tail.read();
            if !updates.is_empty() {
                quiet_since = None;
                progressed = Instant::now();
            }
            for task in tail.take_finished() {
                shared.finish_command(&task.command, &task.result);
            }
            for update in &updates {
                self.shown.lock().unwrap().record(update);
                match self.absorb_subagent(&parent, update) {
                    Some(events) => {
                        for event in events {
                            let _ = self.events.send(event);
                        }
                    }
                    None => shared.apply_step(update),
                }
            }
            if tail.waiting_on_tool() && progressed.elapsed() > TOOL_STALL {
                let _ = shared.nudge(NUDGE);
                return;
            }
            let (running, children) = {
                let subagents = self.subagents.lock().unwrap();
                (subagents.has_running(), subagents.child_ids())
            };
            if !running {
                if tail.settled(&children) {
                    return;
                }
                let since = *quiet_since.get_or_insert_with(Instant::now);
                if since.elapsed() > PARENT_REPLY {
                    if tail.errored() {
                        let _ = self.events.send(SessionEventBody::Error { message: RULES.error_message("") });
                    }
                    return;
                }
            }
            tokio::time::sleep(PARENT_POLL).await;
        }
    }

    fn turn_ended(&self, shared: &Arc<Shared>, status: SessionStatus) {
        let (last, plan) = {
            let mut map = shared.map.lock().unwrap();
            (map.last_message().to_string(), map.take_plan())
        };
        self.update_goal(&last, status);
        let planning = shared.wanted.lock().unwrap().plan;
        if let (SessionStatus::Completed, true, Some(plan)) = (status, planning, plan) {
            if shared.is_idle() {
                self.offer_plan(shared, plan);
            }
        }
    }

    fn reopen_params(&self, shared: &Shared, roots: &[String]) -> Option<Value> {
        Some(open::reopen(&shared.project, roots, self.servers.clone()))
    }

    fn after_exit(&self, session_id: &str) {
        if self.probing {
            let _ = directory::remove(session_id);
        }
    }

    fn set_goal(&self, shared: &Arc<Shared>, objective: &str) -> Result<(), AgentError> {
        submit(shared, format!("/goal {objective}"))
    }

    /// 作曲栏里直接写的 `/goal …` 和菜单设的目标一样，都要画目标芯片。
    fn before_submit(&self, text: &str) {
        let Some(objective) = goal_objective(text) else {
            return;
        };
        if objective.eq_ignore_ascii_case("clear") {
            self.clear_goal_state();
        } else {
            self.set_goal_state(objective, "active");
        }
    }

    /// `/goal` 只是这一回合的提示，会话里没有目标状态可清。回合还在跑就停下，别让它继续做。
    fn clear_goal(&self, shared: &Arc<Shared>) -> Result<(), AgentError> {
        shared.interrupt()?;
        self.clear_goal_state();
        Ok(())
    }

    fn publish_goal(&self, _shared: &Shared) {
        if self.goal.lock().unwrap().is_some() {
            self.publish();
        }
    }

    fn set_goal_status(&self, shared: &Arc<Shared>, status: &str) -> Result<(), AgentError> {
        let objective = self
            .goal
            .lock()
            .unwrap()
            .as_ref()
            .map(|goal| goal.objective.clone())
            .ok_or_else(|| AgentError::Runtime("当前没有目标".into()))?;
        match status {
            "paused" => {
                shared.interrupt()?;
                self.set_goal_state(&objective, "paused");
                Ok(())
            }
            "active" => self.set_goal(shared, &objective),
            other => Err(AgentError::Runtime(format!("不认识的目标状态 {other}"))),
        }
    }
}

/// `/goal <目标>` 的目标正文。
pub fn goal_objective(text: &str) -> Option<&str> {
    let rest = text.trim_start().strip_prefix("/goal")?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some(rest.trim()).filter(|objective| !objective.is_empty())
}

fn submit(shared: &Arc<Shared>, text: String) -> Result<(), AgentError> {
    let turn = UserTurn { text, images: Vec::new(), client_id: String::new(), annotations: Vec::new() };
    shared.submit(Input::new(turn)?, false).map(|_| ())
}

/// 「实施此计划？」。Antigravity 交计划后回合就结束了，没有等回答的请求，由宿主接着发下一条。
struct PlanOffer {
    plan: String,
}

impl PendingAnswer for PlanOffer {
    fn respond(&self, answer: &PromptAnswer) -> Result<(Value, String), AgentError> {
        let PromptAnswer::Single { value } = answer else {
            return Err(AgentError::Runtime("请选择一个选项".into()));
        };
        match classify_plan_answer(value, Some(&self.plan)).map_err(AgentError::Runtime)? {
            PlanChoice::Feedback(text) => Ok((json!({ "feedback": text }), text)),
            PlanChoice::Selected(choice) => Ok((json!({ "choice": choice.id }), choice.label)),
        }
    }

    fn settled(&self, shared: &Arc<Shared>, result: &Value) {
        if let Some(text) = result.get("feedback").and_then(Value::as_str) {
            submit_later(shared.clone(), text.to_string());
            return;
        }
        match result.get("choice").and_then(Value::as_str) {
            Some(IMPLEMENT_ID) => {
                shared.set_plan(false);
                submit_later(shared.clone(), PLAN_IMPLEMENTATION_CODING_MESSAGE.to_string());
            }
            Some(CLEAR_CONTEXT_ID) => {
                let _ = shared.events.send(SessionEventBody::NewThread {
                    name: None,
                    text: Some(format!("{PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX}\n\n{}", self.plan)),
                    worktree: false,
                });
            }
            _ => {}
        }
    }
}

/// 回答卡片时还持着状态锁，发送要等它放开。
fn submit_later(shared: Arc<Shared>, text: String) {
    tokio::spawn(async move {
        let bubble = text.clone();
        match submit(&shared, text) {
            Ok(()) => {
                let _ = shared.events.send(SessionEventBody::UserMessage {
                    text: bubble,
                    images: Vec::new(),
                    annotations: 0,
                    sender: None,
                });
            }
            Err(err) => {
                let _ = shared.events.send(SessionEventBody::Error { message: err.to_string() });
            }
        }
    });
}
