//! `thread/queue/*`。排队卡片不进时间线；消失且不是用户删除时，补一条用户气泡。
//!
//! `followUpQueueMode`：`queue` 时回合中的后续输入走 `thread/queue/add`，
//! `steer` 时走 `turn/steer`。模式按会话保留，不随回合结束改回去，也不删除已排队的消息。
//! 引导对应桌面 `sendQueuedMessageNow`（`queueModeOverride: send-now`）：
//! 把这条排队消息送出，不打断当前模型回合。回合还在时走 `turn/steer`，成功后再
//! `thread/queue/delete`；没有活跃回合时走 `thread/queue/start`。
//! Ctrl+Enter 整队送出也是逐条引导，不把多条正文并成一条，也不改 `followUpQueueMode`。

use std::collections::HashSet;
use std::sync::atomic::Ordering;

use serde_json::{json, Value};

use crate::features::agents::AgentError;
use crate::models::{PageAnnotation, QueuedTurn, SessionEventBody};

use super::catalog::build_turn_input;
use super::history::{image_from_part, user_item_images, user_item_text};
use super::state::{emit, Shared};

pub(super) const QUEUE_GONE: &str = "这条排队消息已经不在队列里";

impl Shared {
    pub(super) fn poke_queue(&self) {
        let _ = self.queue_notify.send(());
    }

    pub(super) async fn refresh_queue(&self) {
        let _guard = self.queue_refresh.lock().await;
        let Some(thread_id) = self.thread_id.lock().unwrap().clone() else {
            return;
        };
        let mut items = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..5 {
            let mut params = json!({ "threadId": thread_id, "limit": 50 });
            if let Some(cursor) = &cursor {
                params["cursor"] = json!(cursor);
            }
            match self.request("thread/queue/list", params).await {
                Ok(page) => {
                    if let Some(data) = page.get("data").and_then(Value::as_array) {
                        for value in data {
                            if let Some(turn) = queued_from_submission(value) {
                                items.push(turn);
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
                Err(err) => {
                    if queue_unsupported(&err) {
                        self.publish_queue(Vec::new());
                    }
                    return;
                }
            }
        }
        self.publish_queue(items);
    }

    pub(super) async fn enqueue(
        &self,
        text: String,
        images: Vec<String>,
        client_id: String,
        annotations: Vec<PageAnnotation>,
    ) -> Result<(), AgentError> {
        self.ensure_thread().await?;
        let thread_id = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Runtime("Codex 线程未建立".into()))?;
        let input = {
            let skills = self.skills.lock().unwrap();
            build_turn_input(&text, &skills, &images, &annotations)
        };
        let result = self
            .request(
                "thread/queue/add",
                json!({
                    "threadId": thread_id,
                    "input": input,
                    "clientUserMessageId": client_id,
                }),
            )
            .await?;
        let submission = result.get("queuedSubmission").unwrap_or(&result);
        let mut turn = queued_from_submission(submission)
            .ok_or_else(|| AgentError::Runtime("Codex 没有返回排队消息".into()))?;
        turn.text = text;
        turn.images = images;
        if turn.client_id.is_empty() {
            turn.client_id = client_id;
        }
        self.queued.lock().unwrap().push(turn);
        self.refresh_queue().await;
        Ok(())
    }

    pub(super) async fn update_queued(
        &self,
        id: &str,
        text: String,
        images: Vec<String>,
        annotations: Vec<PageAnnotation>,
    ) -> Result<(), AgentError> {
        let thread_id = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Runtime("Codex 线程未建立".into()))?;
        let input = {
            let skills = self.skills.lock().unwrap();
            build_turn_input(&text, &skills, &images, &annotations)
        };
        let result = self
            .request(
                "thread/queue/update",
                json!({
                    "threadId": thread_id,
                    "queuedSubmissionId": id,
                    "input": input,
                }),
            )
            .await
            .map_err(map_missing)?;
        if result.get("queuedSubmission").is_none() && result.get("id").is_none() {
            return Err(AgentError::Runtime(QUEUE_GONE.into()));
        }
        {
            let mut queued = self.queued.lock().unwrap();
            let Some(item) = queued.iter_mut().find(|item| item.id == id) else {
                return Err(AgentError::Runtime(QUEUE_GONE.into()));
            };
            item.text = text;
            item.images = images;
        }
        self.refresh_queue().await;
        Ok(())
    }

    pub(super) async fn remove_queued(&self, id: &str) -> Result<(), AgentError> {
        let thread_id = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Runtime("Codex 线程未建立".into()))?;
        self.queue_removed.lock().unwrap().insert(id.to_string());
        let result = self
            .request(
                "thread/queue/delete",
                json!({
                    "threadId": thread_id,
                    "queuedSubmissionId": id,
                }),
            )
            .await;
        match result {
            Ok(value) => {
                if !value.get("deleted").and_then(Value::as_bool).unwrap_or(true) {
                    self.queue_removed.lock().unwrap().remove(id);
                    self.refresh_queue().await;
                    return Err(AgentError::Runtime(QUEUE_GONE.into()));
                }
            }
            Err(err) => {
                self.queue_removed.lock().unwrap().remove(id);
                self.refresh_queue().await;
                return Err(map_missing(err));
            }
        }
        self.refresh_queue().await;
        Ok(())
    }

    pub(super) fn set_follow_up_queue_mode(&self, mode: FollowUpQueueMode) {
        self.follow_up_steer
            .store(mode == FollowUpQueueMode::Steer, Ordering::SeqCst);
    }

    /// 引导：把这条排队消息送出，不打断当前模型回合。回合已经结束则马上开跑。
    pub(super) async fn steer_queued(&self, id: &str) -> Result<(), AgentError> {
        let Some(item) = self.queued_item(id).await else {
            return Err(AgentError::Runtime(QUEUE_GONE.into()));
        };
        if queued_dispatch(self.turn_open.load(Ordering::SeqCst)) == QueuedDispatch::Steer {
            let input = {
                let skills = self.skills.lock().unwrap();
                build_turn_input(&item.text, &skills, &item.images, &[])
            };
            match self.steer_input(input).await {
                Ok(()) => {}
                Err(err) if steer_no_turn(&err) => return self.start_queued(id).await,
                Err(err) => return Err(err),
            }
            if !item.client_id.is_empty() {
                self.shown_users.lock().unwrap().insert(item.client_id);
            }
            if !item.text.is_empty() || !item.images.is_empty() {
                emit(
                    &self.events,
                    SessionEventBody::UserMessage {
                        text: item.text,
                        images: item.images,
                        annotations: 0,
                    },
                );
            }
            if let Err(err) = self.remove_queued(id).await {
                return Err(AgentError::Runtime(format!(
                    "引导已提交，队列没能移除这条消息：{err}"
                )));
            }
            return Ok(());
        }
        self.start_queued(id).await
    }

    pub(super) async fn steer_user_turn(
        &self,
        text: String,
        images: Vec<String>,
        annotations: Vec<PageAnnotation>,
    ) -> Result<(), AgentError> {
        let input = {
            let skills = self.skills.lock().unwrap();
            build_turn_input(&text, &skills, &images, &annotations)
        };
        self.steer_input(input).await
    }

    /// 按队列顺序逐条引导。每条仍走单条引导，图片和正文不并到一起。
    /// 空闲时第一条用 `thread/queue/start` 开回合；后面的要等这个回合有了 turn id，
    /// 再 `turn/steer`。不能在回合还没起来时连打 start，否则会再开一轮。
    pub(super) async fn flush_queued(&self, ids: Vec<String>) -> Result<(), AgentError> {
        let mut started_while_idle = false;
        for id in ids {
            if id.is_empty() {
                continue;
            }
            let open = self.turn_open.load(Ordering::SeqCst);
            match flush_step(open, started_while_idle) {
                FlushStep::Steer => self.steer_queued(&id).await?,
                FlushStep::Start => {
                    self.steer_queued(&id).await?;
                    started_while_idle = true;
                }
                FlushStep::WaitThenSteer => {
                    self.wait_for_steer().await?;
                    self.steer_queued(&id).await?;
                }
            }
        }
        Ok(())
    }

    async fn wait_for_steer(&self) -> Result<(), AgentError> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if self.closed.load(Ordering::SeqCst) {
                return Err(AgentError::Closed);
            }
            let ready =
                self.turn_open.load(Ordering::SeqCst) && self.turn_id.lock().unwrap().is_some();
            if ready {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(AgentError::Runtime(
                    "队列还没接上当前回合，剩下的消息仍留在队列里".into(),
                ));
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    async fn queued_item(&self, id: &str) -> Option<QueuedTurn> {
        let found = self
            .queued
            .lock()
            .unwrap()
            .iter()
            .find(|item| item.id == id)
            .cloned();
        if found.is_some() {
            return found;
        }
        self.refresh_queue().await;
        self.queued
            .lock()
            .unwrap()
            .iter()
            .find(|item| item.id == id)
            .cloned()
    }

    async fn start_queued(&self, id: &str) -> Result<(), AgentError> {
        let thread_id = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Runtime("Codex 线程未建立".into()))?;
        self.request(
            "thread/queue/start",
            json!({
                "threadId": thread_id,
                "queuedSubmissionId": id,
            }),
        )
        .await
        .map_err(map_missing)?;
        self.refresh_queue().await;
        Ok(())
    }

    /// 只认仍在队列里、且带 clientId 的 userMessage。直接发送和斜杠回显没有这个 id。
    pub(super) fn note_user_item(&self, item: &Value) {
        let client_id = item
            .get("clientId")
            .or_else(|| item.get("clientUserMessageId"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if client_id.is_empty() || self.shown_users.lock().unwrap().contains(&client_id) {
            return;
        }
        let turn = self
            .queued
            .lock()
            .unwrap()
            .iter()
            .find(|turn| turn.client_id == client_id)
            .cloned();
        let Some(turn) = turn else {
            return;
        };
        self.shown_users.lock().unwrap().insert(client_id);
        let text = if turn.text.is_empty() {
            user_item_text(item)
        } else {
            turn.text
        };
        let images = if turn.images.is_empty() {
            user_item_images(item)
        } else {
            turn.images
        };
        if text.is_empty() && images.is_empty() {
            return;
        }
        emit(
            &self.events,
            SessionEventBody::UserMessage { text, images, annotations: 0 },
        );
    }

    fn publish_queue(&self, incoming: Vec<QueuedTurn>) {
        let previous = self.queued.lock().unwrap().clone();
        let removed = self.queue_removed.lock().unwrap().clone();
        let shown = self.shown_users.lock().unwrap().clone();
        let (merged, dispatched) = diff_queue(&previous, incoming, &removed, &shown);
        *self.queued.lock().unwrap() = merged.clone();
        self.queue_removed
            .lock()
            .unwrap()
            .retain(|id| merged.iter().any(|item| &item.id == id));
        {
            let mut shown = self.shown_users.lock().unwrap();
            for item in &dispatched {
                if !item.client_id.is_empty() {
                    shown.insert(item.client_id.clone());
                }
                emit(
                    &self.events,
                    SessionEventBody::UserMessage {
                        text: item.text.clone(),
                        images: item.images.clone(),
                        annotations: 0,
                    },
                );
            }
        }
        emit(
            &self.events,
            SessionEventBody::QueueChanged { items: merged },
        );
    }
}

pub(super) fn queued_from_submission(value: &Value) -> Option<QueuedTurn> {
    let id = value.get("id").and_then(Value::as_str)?.to_string();
    if id.is_empty() {
        return None;
    }
    let parts = value
        .get("input")
        .or_else(|| value.get("content"))
        .and_then(Value::as_array);
    let (text, images) = match parts {
        Some(parts) => collect_parts(parts),
        None => (String::new(), Vec::new()),
    };
    let client_id = value
        .get("clientUserMessageId")
        .or_else(|| value.get("clientId"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Some(QueuedTurn {
        id,
        text,
        images,
        client_id,
    })
}

fn collect_parts(parts: &[Value]) -> (String, Vec<String>) {
    let mut text = Vec::new();
    let mut images = Vec::new();
    for part in parts {
        let kind = part.get("type").and_then(Value::as_str).unwrap_or("text");
        if kind == "text" || kind == "input_text" {
            if let Some(piece) = part.get("text").and_then(Value::as_str) {
                if !piece.is_empty() {
                    text.push(piece.to_string());
                }
            }
            continue;
        }
        if let Some(image) = image_from_part(part) {
            images.push(image);
        }
    }
    (text.join("\n"), images)
}

/// 保留客户端原文和路径。从列表消失、且不是用户删掉的，视为已发出。
pub(super) fn diff_queue(
    previous: &[QueuedTurn],
    incoming: Vec<QueuedTurn>,
    removed: &HashSet<String>,
    shown: &HashSet<String>,
) -> (Vec<QueuedTurn>, Vec<QueuedTurn>) {
    let merged = incoming
        .into_iter()
        .map(|mut item| {
            if let Some(prev) = previous.iter().find(|prev| prev.id == item.id) {
                item.text = prev.text.clone();
                item.images = prev.images.clone();
                if item.client_id.is_empty() {
                    item.client_id = prev.client_id.clone();
                }
            }
            item
        })
        .collect::<Vec<_>>();
    let dispatched = previous
        .iter()
        .filter(|prev| {
            if merged.iter().any(|item| item.id == prev.id) {
                return false;
            }
            if removed.contains(&prev.id) {
                return false;
            }
            !prev.client_id.is_empty() && !shown.contains(&prev.client_id)
        })
        .cloned()
        .collect();
    (merged, dispatched)
}

fn queue_unsupported(err: &AgentError) -> bool {
    let msg = err.to_string().to_ascii_lowercase();
    msg.contains("ephemeral")
        || msg.contains("does not support")
        || msg.contains("method not found")
        || msg.contains("unknown method")
}

/// 桌面 `followUpQueueMode`。切换它不删除队列。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FollowUpQueueMode {
    Queue,
    Steer,
}

pub(super) fn parse_follow_up_queue_mode(mode: &str) -> Result<FollowUpQueueMode, AgentError> {
    match mode {
        "queue" => Ok(FollowUpQueueMode::Queue),
        "steer" => Ok(FollowUpQueueMode::Steer),
        _ => Err(AgentError::Runtime("队列模式只能是 queue 或 steer".into())),
    }
}

/// 回合进行中：`queue` 排队，`steer` 写进当前回合。空闲时总是新回合。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FollowUp {
    StartTurn,
    Steer,
    Enqueue,
}

pub(super) fn follow_up(turn_open: bool, mode: FollowUpQueueMode) -> FollowUp {
    if !turn_open {
        FollowUp::StartTurn
    } else if mode == FollowUpQueueMode::Steer {
        FollowUp::Steer
    } else {
        FollowUp::Enqueue
    }
}

/// Ctrl+Enter 这一条。不看会话上存的 followUpQueueMode，所以不会把它改掉。
pub(super) fn send_now(turn_open: bool) -> FollowUp {
    follow_up(turn_open, FollowUpQueueMode::Steer)
}

/// 整队送出的下一步。不合并条目。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FlushStep {
    Steer,
    Start,
    WaitThenSteer,
}

pub(super) fn flush_step(turn_open: bool, started_while_idle: bool) -> FlushStep {
    if turn_open {
        FlushStep::Steer
    } else if started_while_idle {
        FlushStep::WaitThenSteer
    } else {
        FlushStep::Start
    }
}

/// 引导按钮。回合还在就 steer，否则让这条排队消息自己开跑。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum QueuedDispatch {
    Steer,
    Start,
}

pub(super) fn queued_dispatch(turn_open: bool) -> QueuedDispatch {
    if turn_open {
        QueuedDispatch::Steer
    } else {
        QueuedDispatch::Start
    }
}

pub(super) fn steer_no_turn(err: &AgentError) -> bool {
    let msg = err.to_string();
    msg.contains("回合已结束") || msg.to_ascii_lowercase().contains("no active turn")
}

fn map_missing(err: AgentError) -> AgentError {
    let msg = err.to_string().to_ascii_lowercase();
    if msg.contains("no longer") || msg.contains("not found") || msg.contains("missing field") {
        AgentError::Runtime(QUEUE_GONE.into())
    } else {
        err
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(id: &str, text: &str) -> QueuedTurn {
        QueuedTurn {
            id: id.into(),
            text: text.into(),
            images: vec!["C:/shot.png".into()],
            client_id: format!("c-{id}"),
        }
    }

    #[test]
    fn parses_queue_submission_and_keeps_client_copy_on_refresh() {
        let parsed = queued_from_submission(&json!({
            "id": "q1",
            "clientUserMessageId": "c-q1",
            "input": [
                { "type": "text", "text": "服务端快照" },
                { "type": "image", "url": "data:image/png;base64,aaaa" }
            ]
        }))
        .unwrap();
        assert_eq!(parsed.text, "服务端快照");
        assert_eq!(parsed.images, vec!["data:image/png;base64,aaaa"]);
        let previous = vec![turn("q1", "原文")];
        let (merged, dispatched) =
            diff_queue(&previous, vec![parsed], &HashSet::new(), &HashSet::new());
        assert!(dispatched.is_empty());
        assert_eq!(merged[0].text, "原文");
        assert_eq!(merged[0].images, vec!["C:/shot.png"]);
    }

    #[test]
    fn vanish_without_delete_dispatches_once() {
        let previous = vec![turn("q1", "稍后")];
        let (merged, dispatched) =
            diff_queue(&previous, Vec::new(), &HashSet::new(), &HashSet::new());
        assert!(merged.is_empty());
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].text, "稍后");

        let mut removed = HashSet::new();
        removed.insert("q1".into());
        let (_, deleted) = diff_queue(&previous, Vec::new(), &removed, &HashSet::new());
        assert!(deleted.is_empty());
    }

    #[test]
    fn follow_up_queue_mode_steers_without_clearing_the_queue() {
        assert_eq!(
            parse_follow_up_queue_mode("queue").unwrap(),
            FollowUpQueueMode::Queue
        );
        assert_eq!(
            parse_follow_up_queue_mode("steer").unwrap(),
            FollowUpQueueMode::Steer
        );
        assert!(parse_follow_up_queue_mode("close").is_err());
        assert_eq!(
            follow_up(true, FollowUpQueueMode::Queue),
            FollowUp::Enqueue
        );
        assert_eq!(follow_up(true, FollowUpQueueMode::Steer), FollowUp::Steer);
        assert_eq!(
            follow_up(false, FollowUpQueueMode::Steer),
            FollowUp::StartTurn
        );
        assert_eq!(
            follow_up(false, FollowUpQueueMode::Queue),
            FollowUp::StartTurn
        );
    }

    #[test]
    fn ctrl_enter_steers_without_reading_the_saved_queue_mode() {
        assert_eq!(send_now(true), FollowUp::Steer);
        assert_eq!(send_now(false), FollowUp::StartTurn);
        assert_ne!(send_now(true), FollowUp::Enqueue);
        assert_eq!(follow_up(true, FollowUpQueueMode::Queue), FollowUp::Enqueue);
    }

    #[test]
    fn idle_flush_starts_once_then_steers_each_remaining_row() {
        assert_eq!(flush_step(false, false), FlushStep::Start);
        assert_eq!(flush_step(false, true), FlushStep::WaitThenSteer);
        assert_eq!(flush_step(true, false), FlushStep::Steer);
        assert_eq!(flush_step(true, true), FlushStep::Steer);
        let mut started = false;
        let mut open = false;
        let mut steps = Vec::new();
        for index in 0..3 {
            let step = flush_step(open, started);
            if step == FlushStep::Start {
                started = true;
                if index == 0 {
                    open = true;
                }
            }
            steps.push(step);
        }
        assert_eq!(
            steps,
            vec![FlushStep::Start, FlushStep::Steer, FlushStep::Steer]
        );
    }

    #[test]
    fn steer_button_starts_the_item_when_the_turn_is_idle() {
        assert_eq!(queued_dispatch(true), QueuedDispatch::Steer);
        assert_eq!(queued_dispatch(false), QueuedDispatch::Start);
        assert!(steer_no_turn(&AgentError::Runtime("Codex 回合已结束".into())));
        assert!(steer_no_turn(&AgentError::Runtime(
            "no active turn to steer".into()
        )));
        assert!(!steer_no_turn(&AgentError::Runtime(
            "cannot steer a review turn".into()
        )));
    }
}
