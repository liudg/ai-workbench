//! 嵌套任务开出来之后的事：回报父任务，父任务读、发消息、打断自己的子任务。开出来的那一步在 `agent_sessions`。
//! 见 `docs/agent-orchestration.md`。工具层在 `crate::mcp::sessions`，这里是规则和数据。

mod reports;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use aiwb_core::attention::{AskKind, AttentionState};
use aiwb_core::models::{now_millis, AgentKind, MessageSender, SessionEventBody, SessionStatus};
use aiwb_core::task::{Task, TaskSession};
use serde::Serialize;
use serde_json::{json, Value};

use super::{ServiceResult, Services};
use super::Caller;
use crate::runtime::{task_branch, Outgoing, StatusNote};

use reports::{Batch, Driver, Note, Reports};

/// 回报里每个子任务的回答留多少字。
const ANSWER_CHARS: usize = 400;
/// 父会话的草稿这么久内改过，算用户正在打字，回报晚点再送。
const TYPING_MS: i64 = 30_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubtaskRow {
    task_id: String,
    title: String,
    agent: AgentKind,
    state: AttentionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    ask: Option<AskKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
}

/// 嵌套任务在内存里的状态。
#[derive(Default)]
pub(crate) struct SubtaskState {
    reports: Mutex<Reports>,
    /// 正在送回报的父任务 → 期间又有新结果要看。
    flushing: Mutex<HashMap<String, bool>>,
}

impl Services {
    /// 接上会话状态变化，送子任务回报。daemon 启动时调用一次。
    pub fn start_subtask_reports(self: &Arc<Self>) {
        let Some(mut notes) = self.runtimes.take_status_notes() else {
            return;
        };
        let services = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(note) = notes.recv().await {
                // 结果按顺序记；送回报各个父任务分开跑，一个父会话起得慢不耽误别的。
                for target in services.note_status(&note) {
                    let services = Arc::clone(&services);
                    tokio::spawn(async move { services.flush_reports(&target).await });
                }
            }
        });
    }

    /// 记下子任务回合的结果，返回有东西要送的任务：它自己（中间层既是子任务也是父任务，空下来时要收
    /// 自己子任务的回报）和往上的每一层（它们可能正等着下面停下）。
    fn note_status(&self, note: &StatusNote) -> Vec<String> {
        let Some(task) = self.store.task(&note.task_id).ok().flatten() else {
            return Vec::new();
        };
        if task.archived_at.is_some() {
            return Vec::new();
        }
        if let Some(parent) = &task.parent_task_id {
            self.reports().turn_ended(parent, &task.id, note.status);
        }
        let mut targets = vec![task.id];
        let mut above = task.parent_task_id;
        while let Some(id) = above {
            above = self.store.task(&id).ok().flatten().and_then(|task| task.parent_task_id);
            targets.push(id);
        }
        let reports = self.reports();
        targets.retain(|id| reports.pending(id));
        targets
    }

    fn reports(&self) -> std::sync::MutexGuard<'_, Reports> {
        self.subtasks.reports.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 这个父任务正在开一批子任务，开完之前不叫醒它。放手时自动放开。
    pub(super) fn hold_reports(&self, parent: &str) -> Held<'_> {
        Held::new(self, parent)
    }

    /// 开出了一个子任务，它的结果要回报给父任务。
    pub(super) fn expect_report(&self, parent: &str, task_id: &str) {
        self.reports().opened(parent, task_id);
    }

    /// 给会话留一条消息（卡片的结果），空闲时送出。
    pub(super) async fn send_note(&self, task_id: &str, text: String, task_ids: Vec<String>) {
        self.reports().note(task_id, Note { text, task_ids });
        self.flush_reports(task_id).await;
    }

    pub(crate) fn list_subtasks(&self, caller: &Caller) -> ServiceResult<Vec<SubtaskRow>> {
        Ok(self
            .store
            .task_entries()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|entry| {
                entry.task.parent_task_id.as_deref() == Some(caller.task.id.as_str()) && entry.task.archived_at.is_none()
            })
            .filter_map(|entry| {
                let current = entry.sessions.last()?;
                Some(SubtaskRow {
                    task_id: entry.task.id.clone(),
                    branch: task_branch(&entry.task),
                    title: entry.task.title,
                    agent: current.agent,
                    state: entry.attention.state,
                    ask: entry.attention.ask,
                    last_message: entry.attention.preview,
                })
            })
            .collect())
    }

    /// 只认调用方任务下的子任务，和它现在用的会话。
    fn own_subtask(&self, caller: &Caller, task_id: &str) -> ServiceResult<(Task, TaskSession)> {
        let store_err = |e: aiwb_store::StoreError| e.to_string();
        let task = self
            .store
            .task(task_id)
            .map_err(store_err)?
            .filter(|task| {
                task.parent_task_id.as_deref() == Some(caller.task.id.as_str()) && task.archived_at.is_none()
            })
            .ok_or_else(|| format!("not_found: you have no subtask {task_id}, or it was archived"))?;
        let session = self
            .store
            .task_sessions(task_id)
            .map_err(store_err)?
            .pop()
            .ok_or_else(|| "not_found: the subtask has no session".to_string())?;
        Ok((task, session))
    }

    /// 分页读子任务的时间线，从新往旧翻。缺省只有消息、回答和计划。
    pub(crate) fn read_subtask(
        &self,
        caller: &Caller,
        task_id: &str,
        before: Option<u64>,
        limit: usize,
        all: bool,
    ) -> ServiceResult<Value> {
        let (task, session) = self.own_subtask(caller, task_id)?;
        let items: Vec<Value> = self
            .store
            .events_since(&session.id, 0)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|stored| before.is_none_or(|before| stored.event.seq < before))
            .filter_map(|stored| {
                let (kind, text) = timeline_item(&stored.event.body, all)?;
                Some(json!({ "seq": stored.event.seq, "kind": kind, "text": text }))
            })
            .collect();
        let limit = limit.clamp(1, 100);
        let start = items.len().saturating_sub(limit);
        let next_before = (start > 0).then(|| items[start]["seq"].clone());
        let state = self
            .store
            .attention(&session.id)
            .map_err(|e| e.to_string())?
            .map(|attention| attention.state);
        Ok(json!({
            "taskId": task.id,
            "title": task.title,
            "state": state,
            "branch": task_branch(&task),
            "items": items[start..],
            "nextBefore": next_before,
        }))
    }

    /// 给子任务追加消息。子任务在等用户批准或回答时拒绝，不替用户答（照 herdr `agent_blocked`）。
    pub(crate) async fn send_subtask(&self, caller: &Caller, task_id: &str, text: String, steer: bool) -> ServiceResult<Value> {
        reject_command(&text)?;
        let (task, session) = self.own_subtask(caller, task_id)?;
        let waiting = self
            .store
            .attention(&session.id)
            .map_err(|e| e.to_string())?
            .is_some_and(|attention| attention.state == AttentionState::NeedsInput);
        if waiting {
            return Err("blocked: the subtask is waiting for the user's approval or answer. Tell the user to handle it; never answer on their behalf.".into());
        }
        self.reports().drive(&task.id, Driver::Parent);
        let message = Outgoing {
            sender: Some(MessageSender {
                task_ids: vec![caller.task.id.clone()],
            }),
            ..Outgoing::user(text, Vec::new(), steer)
        };
        let delivery = self.runtimes.send_message(&session.id, message).await?;
        Ok(json!({ "queued": delivery == aiwb_agents::TurnDelivery::Queued }))
    }

    pub(crate) async fn interrupt_subtask(&self, caller: &Caller, task_id: &str) -> ServiceResult<()> {
        let (_, session) = self.own_subtask(caller, task_id)?;
        self.runtimes.interrupt(&session.id).await
    }

    /// 用户在界面上发消息。子任务里用户自己开的回合不叫醒父会话；
    /// 父会话里发消息时把没送出的回报一起带上。
    pub(crate) async fn send_from_user(&self, session_id: &str, mut message: Outgoing) -> ServiceResult<aiwb_agents::TurnDelivery> {
        let store_err = |e: aiwb_store::StoreError| e.to_string();
        let session = self.store.session(session_id).map_err(store_err)?;
        let main = match &session {
            Some(session) if !self.store.is_side_session(session_id).map_err(store_err)? => {
                self.store.task(&session.task_id).map_err(store_err)?
            }
            _ => None,
        };
        let command = message.text.trim_start().starts_with('/');
        let mut taken = None;
        if let (Some(session), Some(task)) = (&session, &main) {
            let idle = !matches!(session.status, SessionStatus::Starting | SessionStatus::Running | SessionStatus::NeedsInput);
            // 斜杠命令照原样发，回报留到下一条普通消息。
            if idle && !message.now && !command {
                taken = self.reports().take_for_user(&task.id);
                if let Some(batch) = &taken {
                    message.preface = Some((self.report_text(batch), sender_of(batch)));
                }
            }
        }
        let sent = self.runtimes.send_message(session_id, message).await;
        match (&sent, &main) {
            (Err(_), Some(task)) => {
                if let Some(batch) = taken {
                    self.reports().restore(&task.id, batch);
                }
            }
            // 用户说了话（不算命令）：在父任务里重新开始数叫醒次数，在子任务里这一回合算用户的。
            (Ok(_), Some(task)) if !command => {
                self.reports().user_spoke(&task.id);
                if task.parent_task_id.is_some() {
                    self.reports().drive(&task.id, Driver::User);
                }
            }
            _ => {}
        }
        sent
    }

    /// 父会话空闲、用户没在打字时，把该送的回报送出去。
    /// 用户在打字时不打断，留着等用户发消息时一起带上（[`Self::send_from_user`]），或者下一次状态变化再看。
    async fn flush_reports(&self, parent_id: &str) {
        // 同一个父任务同时只有一个在送。别处想送时记一笔，正在送的这个做完再看一遍。
        let Some(flushing) = Flushing::claim(&self.subtasks.flushing, parent_id) else {
            return;
        };
        loop {
            self.flush_once(parent_id).await;
            if !flushing.again() {
                break;
            }
        }
    }

    async fn flush_once(&self, parent_id: &str) {
        // 归档的父任务不叫醒，结果留着等它回来。
        if !self.store.task(parent_id).ok().flatten().is_some_and(|task| task.archived_at.is_none()) {
            return;
        }
        let Ok(Some(session)) = self.store.task_sessions(parent_id).map(|mut sessions| sessions.pop()) else {
            return;
        };
        if matches!(session.status, SessionStatus::Starting | SessionStatus::Running | SessionStatus::NeedsInput) {
            return;
        }
        if self.typing(&session.id) {
            return;
        }
        let descendants_working = self.descendants_working(parent_id);
        let Some(batch) = self.reports().take_for_wake(parent_id, descendants_working) else {
            return;
        };
        // 立刻送：父会话这时空着就开一个回合；刚好有回合开起来时引导进去，不排进队列变成用户的消息。
        let message = Outgoing {
            sender: Some(sender_of(&batch)),
            ..Outgoing::user(self.report_text(&batch), Vec::new(), true)
        };
        if let Err(err) = self.runtimes.send_message(&session.id, message).await {
            eprintln!("给任务 {parent_id} 送子任务回报失败：{err}");
            self.reports().restore(parent_id, batch);
        }
    }

    fn typing(&self, session_id: &str) -> bool {
        let Ok(Some((draft, at))) = self.store.draft_entry(session_id) else {
            return false;
        };
        let has_text = draft.get("text").and_then(Value::as_str).is_some_and(|text| !text.trim().is_empty());
        has_text && now_millis() - at < TYPING_MS
    }

    /// 下面哪一层还没做完就先不叫醒：孙任务跑完，子任务还会接着做一轮。在等用户的不算，父任务要知道这件事。
    fn descendants_working(&self, parent_id: &str) -> bool {
        let Ok(entries) = self.store.task_entries() else {
            return false;
        };
        let parents: HashMap<&str, &str> = entries
            .iter()
            .filter_map(|entry| Some((entry.task.id.as_str(), entry.task.parent_task_id.as_deref()?)))
            .collect();
        let reports = self.reports();
        entries.iter().any(|entry| {
            let unfinished = match entry.attention.state {
                AttentionState::Starting | AttentionState::Working => true,
                AttentionState::NeedsInput => false,
                _ => reports.expecting(&entry.task.id),
            };
            unfinished
                && entry.task.archived_at.is_none()
                && aiwb_core::task::ancestors(&parents, &entry.task.id).any(|id| id == parent_id)
        })
    }

    /// 任务要删掉或归档了：它的结果和「还在起」都不再等，父任务可能因此可以叫醒了。
    pub(crate) async fn forget_subtask(&self, task_id: &str) {
        self.reports().forget(task_id);
        let parent = self.store.task(task_id).ok().flatten().and_then(|task| task.parent_task_id);
        if let Some(parent) = parent {
            self.flush_reports(&parent).await;
        }
    }

    pub(crate) fn revive_subtask(&self, task_id: &str) {
        self.reports().revive(task_id);
    }

    /// 回报正文：卡片结果在前，再是每个子任务的标题、状态、分支和最后一条回答。
    fn report_text(&self, batch: &Batch) -> String {
        let mut parts: Vec<String> = batch.notes.iter().map(|note| note.text.clone()).collect();
        if !batch.results.is_empty() {
            parts.push(
                "Subtasks have new results. Each result is the subtask's own claim: before telling the user something \
                 is done, read it with aiwb_subtask_read or look at the diff in its worktree. To combine several \
                 subtasks' changes, ask the user first and merge only on their yes; never push those branches."
                    .into(),
            );
        }
        for (task_id, outcome) in &batch.results {
            let task = self.store.task(task_id).ok().flatten();
            let title = task.as_ref().map_or("(deleted)", |task| task.title.as_str());
            let mut lines = vec![
                format!("## {title}"),
                format!("taskId: {task_id}"),
                format!("state: {}", status_label(outcome.status)),
            ];
            if let Some(branch) = task.as_ref().and_then(task_branch) {
                lines.push(format!("branch: {branch}"));
            }
            if outcome.status == SessionStatus::NeedsInput {
                lines.push(
                    "It is waiting for the user's approval or answer. Tell the user to handle it; never answer on their behalf."
                        .into(),
                );
            }
            if let Some(answer) = self.last_answer(task_id) {
                lines.push(format!("last answer:\n{answer}"));
            }
            parts.push(lines.join("\n"));
        }
        parts.join("\n\n")
    }

    fn last_answer(&self, task_id: &str) -> Option<String> {
        let session = self.store.task_sessions(task_id).ok()?.pop()?;
        let events = self.store.events_since(&session.id, 0).ok()?;
        let text = events.iter().rev().find_map(|stored| match &stored.event.body {
            SessionEventBody::AgentMessage {
                text, dedupe_of: None, ..
            } if !text.trim().is_empty() => Some(text.trim()),
            _ => None,
        })?;
        let mut chars = text.chars();
        let head: String = chars.by_ref().take(ANSWER_CHARS).collect();
        Some(if chars.next().is_some() { format!("{head}…") } else { head })
    }
}

fn status_label(status: SessionStatus) -> &'static str {
    match status {
        SessionStatus::Starting => "starting",
        SessionStatus::Idle => "idle",
        SessionStatus::Completed => "done",
        SessionStatus::Failed => "failed",
        SessionStatus::NeedsInput => "needs-input",
        SessionStatus::Stopped => "stopped",
        SessionStatus::Running => "working",
    }
}

/// 父任务发给子任务的只能是普通消息：斜杠命令能改子任务的权限和模式，绕过不比父任务宽的规则。
pub(super) fn reject_command(text: &str) -> ServiceResult<()> {
    if text.trim_start().starts_with('/') {
        return Err("invalid: slash commands cannot be sent to a subtask".into());
    }
    Ok(())
}

/// 正在给这个父任务送回报。抢不到的一方留一笔「再看一遍」，放手时自动移除。
struct Flushing<'a> {
    parents: &'a Mutex<HashMap<String, bool>>,
    parent: String,
    /// `again` 已经放过手。之后同名的记录是别人的，`Drop` 不能删。
    released: std::cell::Cell<bool>,
}

impl<'a> Flushing<'a> {
    fn claim(parents: &'a Mutex<HashMap<String, bool>>, parent: &str) -> Option<Self> {
        let mut parents_now = parents.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(again) = parents_now.get_mut(parent) {
            *again = true;
            return None;
        }
        parents_now.insert(parent.to_string(), false);
        Some(Self {
            parents,
            parent: parent.to_string(),
            released: std::cell::Cell::new(false),
        })
    }

    /// 期间有人想送就清掉记号、返回 true；否则在同一把锁里放手，不会漏掉之后来的。
    fn again(&self) -> bool {
        let mut parents = self.parents.lock().unwrap_or_else(|p| p.into_inner());
        match parents.get_mut(&self.parent) {
            Some(again) if *again => {
                *again = false;
                true
            }
            _ => {
                parents.remove(&self.parent);
                self.released.set(true);
                false
            }
        }
    }
}

/// 中途被丢掉（没走到 `again` 放手）时清掉记录。
impl Drop for Flushing<'_> {
    fn drop(&mut self) {
        if !self.released.get() {
            self.parents.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.parent);
        }
    }
}

/// 正在给这个父任务开一批子任务，开完之前不叫醒它。放手时自动放开。
pub(super) struct Held<'a> {
    services: &'a Services,
    parent: String,
}

impl<'a> Held<'a> {
    fn new(services: &'a Services, parent: &str) -> Self {
        services.reports().hold(parent);
        Self {
            services,
            parent: parent.to_string(),
        }
    }
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        self.services.reports().release(&self.parent);
    }
}

fn sender_of(batch: &Batch) -> MessageSender {
    let mut task_ids: Vec<String> = Vec::new();
    let ids = batch
        .notes
        .iter()
        .flat_map(|note| note.task_ids.iter())
        .chain(batch.results.iter().map(|(id, _)| id));
    for id in ids {
        if !task_ids.contains(id) {
            task_ids.push(id.clone());
        }
    }
    MessageSender { task_ids }
}

/// 时间线里给父任务看的一条。`all` 时连工具调用、提问和错误也给。
fn timeline_item(body: &SessionEventBody, all: bool) -> Option<(&'static str, String)> {
    use aiwb_core::models::MessagePhase;
    match body {
        SessionEventBody::UserMessage { text, sender, .. } => {
            Some((if sender.is_some() { "parent" } else { "user" }, text.clone()))
        }
        SessionEventBody::AgentMessage {
            text,
            phase,
            dedupe_of: None,
            ..
        } if all || *phase != Some(MessagePhase::Commentary) => Some(("answer", text.clone())),
        SessionEventBody::PlanText { text, .. } => Some(("plan", text.clone())),
        SessionEventBody::PlanSteps { explanation, steps, .. } => {
            let mut lines: Vec<String> = Vec::new();
            if !explanation.is_empty() {
                lines.push(explanation.clone());
            }
            lines.extend(steps.iter().map(|step| format!("- [{:?}] {}", step.status, step.step)));
            Some(("plan", lines.join("\n")))
        }
        SessionEventBody::ToolCall { name, summary, status, .. } if all => {
            Some(("tool", format!("{name}: {summary} ({status:?})")))
        }
        SessionEventBody::Prompt { question, header, .. } if all => {
            Some(("prompt", if question.is_empty() { header.clone() } else { question.clone() }))
        }
        SessionEventBody::Error { message } if all => Some(("error", message.clone())),
        _ => None,
    }
}
