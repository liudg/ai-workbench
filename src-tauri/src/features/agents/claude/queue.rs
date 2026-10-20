//! 工作台本地排队。
//!
//! 2026-10-15，Claude Code 2.1.300，`--input-format stream-json`：
//! 回合进行中再写一条 user 消息不会报错，也不会改当前回合的 result。
//! 会话 jsonl 记下 `queue-operation` enqueue，当前回合的 result 之后才 dequeue，
//! 下一条 stdout 是新的一轮。所以未写入 stdin 之前，消息留在这里，可以改、可以删。
//! 「引导」或队列模式为 steer 时立刻写入 stdin（Claude 排到下一轮，不打断当前结果）。
//! 当前回合正常结束且用户没有按停止时，再把队首写给 Claude。
//! 已经写进 stdin、结果还没到的条数在 `runtime` 里用 `user_writes` / `user_results` 计，
//! 避免旧 result 把新开的回合标成结束。

use std::sync::atomic::Ordering;

use serde_json::Value;

use super::images;
use super::runtime::Shared;
use crate::features::agents::{AgentError, TurnDelivery};
use crate::models::{QueuedTurn, SessionEventBody, SessionStatus};

pub(super) const QUEUE_GONE: &str = "这条排队消息已经不在队列里";

#[derive(Debug)]
pub(super) struct QueueState {
    pub items: Vec<QueuedTurn>,
    pub steer: bool,
}

impl Default for QueueState {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            steer: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SubmitPlan {
    Start,
    WriteAhead,
    Hold,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ClosePlan {
    Finish,
    Start(QueuedTurn),
}

pub(super) fn plan_submit(busy: bool, steer: bool) -> SubmitPlan {
    if !busy {
        SubmitPlan::Start
    } else if steer {
        SubmitPlan::WriteAhead
    } else {
        SubmitPlan::Hold
    }
}

/// Ctrl+Enter 这一条。强制写进当前回合，不读、也不改会话上存的队列模式。
pub(super) fn plan_submit_now(busy: bool) -> SubmitPlan {
    plan_submit(busy, true)
}

/// `auto_flush`：这一回合正常结束，而且不是用户按下的停止。
/// 一次只取出队首，避免几条紧挨着的写入被 Claude 合成一轮。
pub(super) fn plan_close(state: &mut QueueState, auto_flush: bool) -> ClosePlan {
    if auto_flush && !state.items.is_empty() {
        return ClosePlan::Start(state.items.remove(0));
    }
    ClosePlan::Finish
}

pub(super) fn parse_follow_up_queue_mode(mode: &str) -> Result<bool, AgentError> {
    match mode {
        "queue" => Ok(false),
        "steer" => Ok(true),
        _ => Err(AgentError::Runtime("队列模式只能是 queue 或 steer".into())),
    }
}

fn queued_turn(text: String, images: Vec<String>, client_id: String) -> QueuedTurn {
    QueuedTurn {
        id: uuid::Uuid::new_v4().to_string(),
        text,
        images,
        client_id,
    }
}

impl Shared {
    pub(super) fn submit(
        &self,
        content: Value,
        text: String,
        images: Vec<String>,
        client_id: String,
    ) -> Result<TurnDelivery, AgentError> {
        let steer = self.queue_state.lock().unwrap().steer;
        self.finish_submit(content, text, images, client_id, steer)
    }

    /// 立刻写入。忙的时候走引导那条提前写入，不进本地队列，也不改 steer 开关。
    pub(super) fn submit_now(
        &self,
        content: Value,
        text: String,
        images: Vec<String>,
        client_id: String,
    ) -> Result<TurnDelivery, AgentError> {
        self.finish_submit(content, text, images, client_id, true)
    }

    fn finish_submit(
        &self,
        content: Value,
        text: String,
        images: Vec<String>,
        client_id: String,
        steer: bool,
    ) -> Result<TurnDelivery, AgentError> {
        if text.trim().is_empty() && images.is_empty() {
            return Err(AgentError::Runtime("消息不能为空".into()));
        }
        self.ensure_writable()?;
        let busy = self.busy.load(Ordering::SeqCst);
        let plan = if steer {
            plan_submit_now(busy)
        } else {
            plan_submit(busy, false)
        };
        match plan {
            SubmitPlan::Hold => self.hold(text, images, client_id),
            SubmitPlan::WriteAhead => {
                self.write_user_content(&content)?;
                Ok(TurnDelivery::Started)
            }
            SubmitPlan::Start => match self.begin_turn() {
                Ok(()) => {
                    if let Err(err) = self.write_user_content(&content) {
                        self.fail_turn();
                        return Err(err);
                    }
                    Ok(TurnDelivery::Started)
                }
                Err(AgentError::Busy) => self.hold(text, images, client_id),
                Err(err) => Err(err),
            },
        }
    }

    fn hold(
        &self,
        text: String,
        images: Vec<String>,
        client_id: String,
    ) -> Result<TurnDelivery, AgentError> {
        self.queue_state
            .lock()
            .unwrap()
            .items
            .push(queued_turn(text, images, client_id));
        self.publish_queue();
        Ok(TurnDelivery::Queued)
    }

    pub(super) fn update_queued(
        &self,
        id: &str,
        text: String,
        images: Vec<String>,
    ) -> Result<(), AgentError> {
        if text.trim().is_empty() && images.is_empty() {
            return Err(AgentError::Runtime("消息不能为空".into()));
        }
        let mut state = self.queue_state.lock().unwrap();
        let Some(item) = state.items.iter_mut().find(|item| item.id == id) else {
            return Err(AgentError::Runtime(QUEUE_GONE.into()));
        };
        item.text = text;
        item.images = images;
        drop(state);
        self.publish_queue();
        Ok(())
    }

    pub(super) fn remove_queued(&self, id: &str) -> Result<(), AgentError> {
        let mut state = self.queue_state.lock().unwrap();
        let before = state.items.len();
        state.items.retain(|item| item.id != id);
        if state.items.len() == before {
            return Err(AgentError::Runtime(QUEUE_GONE.into()));
        }
        drop(state);
        self.publish_queue();
        Ok(())
    }

    pub(super) fn steer_queued(&self, id: &str) -> Result<(), AgentError> {
        let item = {
            let mut state = self.queue_state.lock().unwrap();
            let Some(index) = state.items.iter().position(|item| item.id == id) else {
                return Err(AgentError::Runtime(QUEUE_GONE.into()));
            };
            state.items.remove(index)
        };
        self.publish_queue();
        let content = match images::message_content(&item.text, &item.images) {
            Ok(content) => content,
            Err(err) => {
                self.restore_front(item);
                return Err(err);
            }
        };
        if let Err(err) = self.ensure_writable() {
            self.restore_front(item);
            return Err(err);
        }
        if self.busy.load(Ordering::SeqCst) {
            if let Err(err) = self.write_user_content(&content) {
                self.restore_front(item);
                return Err(err);
            }
            self.emit_dispatched(&item);
            return Ok(());
        }
        if let Err(err) = self.begin_turn() {
            self.restore_front(item);
            return Err(err);
        }
        if let Err(err) = self.write_user_content(&content) {
            self.fail_turn();
            self.restore_front(item);
            return Err(err);
        }
        self.emit_dispatched(&item);
        Ok(())
    }

    pub(super) fn set_follow_up_queue_mode(&self, mode: &str) -> Result<(), AgentError> {
        let steer = parse_follow_up_queue_mode(mode)?;
        self.queue_state.lock().unwrap().steer = steer;
        Ok(())
    }

    pub(super) fn queue_on_turn_closed(&self, auto_flush: bool) -> ClosePlan {
        let mut state = self.queue_state.lock().unwrap();
        let plan = plan_close(&mut state, auto_flush);
        drop(state);
        if matches!(plan, ClosePlan::Start(_)) {
            self.publish_queue();
        }
        plan
    }

    fn restore_front(&self, item: QueuedTurn) {
        self.queue_state.lock().unwrap().items.insert(0, item);
        self.publish_queue();
    }

    fn publish_queue(&self) {
        let items = self.queue_state.lock().unwrap().items.clone();
        let _ = self.events.send(SessionEventBody::QueueChanged { items });
    }

    fn emit_dispatched(&self, item: &QueuedTurn) {
        if item.text.trim().starts_with('/') && item.images.is_empty() {
            return;
        }
        if item.text.trim().is_empty() && item.images.is_empty() {
            return;
        }
        let _ = self.events.send(SessionEventBody::UserMessage {
            text: item.text.clone(),
            images: item.images.clone(),
            annotations: 0,
        });
    }

    fn ensure_writable(&self) -> Result<(), AgentError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(AgentError::Closed);
        }
        if !self.prompts.lock().unwrap().is_empty() {
            return Err(AgentError::PendingPrompt);
        }
        Ok(())
    }
}

impl Shared {
    pub(super) fn finish_turn(&self, status: SessionStatus, stopped_by_user: bool) -> ClosePlan {
        let auto_flush = status == SessionStatus::Completed && !stopped_by_user;
        self.queue_on_turn_closed(auto_flush)
    }

    pub(super) fn start_queued_item(&self, item: QueuedTurn) {
        self.arm_turn();
        match images::message_content(&item.text, &item.images) {
            Ok(content) => match self.write_user_content(&content) {
                Ok(()) => {
                    self.emit_dispatched(&item);
                    let _ = self.events.send(SessionEventBody::StatusChanged {
                        status: SessionStatus::Running,
                    });
                }
                Err(err) => self.fail_queued_start(item, err.to_string()),
            },
            Err(err) => self.fail_queued_start(item, err.to_string()),
        }
    }

    fn fail_queued_start(&self, item: QueuedTurn, message: String) {
        self.restore_front(item);
        self.busy.store(false, Ordering::SeqCst);
        let _ = self.events.send(SessionEventBody::Error { message });
        let _ = self.events.send(SessionEventBody::StatusChanged {
            status: SessionStatus::Failed,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, text: &str) -> QueuedTurn {
        QueuedTurn {
            id: id.into(),
            text: text.into(),
            images: Vec::new(),
            client_id: String::new(),
        }
    }

    #[test]
    fn busy_queue_holds_and_steer_writes_ahead() {
        assert_eq!(plan_submit(false, false), SubmitPlan::Start);
        assert_eq!(plan_submit(false, true), SubmitPlan::Start);
        assert_eq!(plan_submit(true, false), SubmitPlan::Hold);
        assert_eq!(plan_submit(true, true), SubmitPlan::WriteAhead);
    }

    #[test]
    fn ctrl_enter_writes_ahead_without_the_saved_queue_mode() {
        assert_eq!(plan_submit_now(false), SubmitPlan::Start);
        assert_eq!(plan_submit_now(true), SubmitPlan::WriteAhead);
        assert_ne!(plan_submit_now(true), SubmitPlan::Hold);
        assert_eq!(plan_submit(true, false), SubmitPlan::Hold);
    }

    #[test]
    fn turn_end_flushes_one_local_item() {
        let mut state = QueueState::default();
        state.items = vec![item("a", "第一条"), item("b", "第二条")];
        match plan_close(&mut state, true) {
            ClosePlan::Start(next) => assert_eq!(next.id, "a"),
            other => panic!("expected start, got {other:?}"),
        }
        assert_eq!(state.items.len(), 1);
        assert_eq!(plan_close(&mut state, false), ClosePlan::Finish);
        assert_eq!(state.items.len(), 1);
    }

    #[test]
    fn stopped_turn_keeps_the_local_queue() {
        let mut state = QueueState {
            items: vec![item("a", "还在")],
            steer: false,
        };
        assert_eq!(plan_close(&mut state, false), ClosePlan::Finish);
        assert_eq!(state.items[0].text, "还在");
    }

    #[test]
    fn queue_mode_parser_rejects_anything_else() {
        assert_eq!(parse_follow_up_queue_mode("queue").unwrap(), false);
        assert_eq!(parse_follow_up_queue_mode("steer").unwrap(), true);
        assert!(parse_follow_up_queue_mode("send").is_err());
    }
}
