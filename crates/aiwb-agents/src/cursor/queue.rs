//! Cursor 的本地待发队列。引导通过 cancel → 等旧 prompt 收尾 → 同 session 新 prompt。
//! 所有调度都持有 status_lock；只有一个 worker，旧响应不能结束新请求。

use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::{json, Value};

use super::prompts;
use super::runtime::Shared;
use super::session::prompt_blocks;
use crate::protocol::fold_page_annotations;
use crate::{AgentError, TurnDelivery, UserTurn};
use aiwb_core::models::{QueuedTurn, SessionEventBody, SessionStatus};

const QUEUE_GONE: &str = "这条排队消息已经不在队列里";

pub(super) struct Input {
    item: QueuedTurn,
    blocks: Vec<Value>,
    annotations: u32,
}

impl Input {
    pub(super) fn new(turn: UserTurn) -> Result<Self, AgentError> {
        let mut images = turn.images;
        let text = fold_page_annotations(&turn.text, &mut images, &turn.annotations);
        let blocks = prompt_blocks(&text, &images)?;
        Ok(Self {
            item: QueuedTurn {
                id: uuid::Uuid::new_v4().to_string(),
                text,
                images,
                client_id: turn.client_id,
            },
            blocks,
            annotations: turn.annotations.len() as u32,
        })
    }
}

#[derive(Default)]
pub(super) struct QueueState {
    held: VecDeque<Input>,
    ready: VecDeque<Input>,
    steer: bool,
    pub(super) in_flight: bool,
    pub(super) observed: bool,
    pub(super) cancelling: bool,
    /// Cursor 不保留取消回合的消息；下次 prompt 显式带回已接收的输入和执行结果。
    interrupted: Vec<Value>,
}

impl Shared {
    pub(super) fn submit(
        self: &Arc<Self>,
        input: Input,
        now: bool,
    ) -> Result<TurnDelivery, AgentError> {
        let _guard = self.status_lock.lock().unwrap();
        self.ensure_open()?;
        let steer = now || self.queue.lock().unwrap().steer;
        let busy = self.busy.load(Ordering::SeqCst);
        if (!busy || steer) && !self.prompts.lock().unwrap().is_empty() {
            return Err(AgentError::PendingPrompt);
        }
        if busy {
            if steer {
                self.queue.lock().unwrap().ready.push_back(input);
                if let Err(err) = self.cancel_for_steering() {
                    self.queue.lock().unwrap().ready.pop_back();
                    return Err(err);
                }
            } else {
                self.queue.lock().unwrap().held.push_back(input);
            }
            self.publish_queue();
            // 等取消收尾才真正发送，用户气泡由 worker 发出，避免重复或次序颠倒。
            return Ok(TurnDelivery::Queued);
        }
        self.begin_run(false);
        self.spawn_worker(input);
        Ok(TurnDelivery::Started)
    }

    fn ensure_open(&self) -> Result<(), AgentError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(AgentError::Closed);
        }
        if self.session_id().is_none() {
            return Err(AgentError::Runtime("Cursor Agent 会话还没有建立".into()));
        }
        Ok(())
    }

    fn begin_run(&self, continuation: bool) {
        self.busy.store(true, Ordering::SeqCst);
        self.user_stopped.store(false, Ordering::SeqCst);
        let plan = self.wanted.lock().unwrap().plan;
        let mut map = self.map.lock().unwrap();
        if continuation {
            map.continue_turn();
        } else {
            let turn_id = uuid::Uuid::new_v4().to_string();
            map.begin_turn(&turn_id);
            let _ = self.events.send(SessionEventBody::TurnAnchor {
                turn_id,
                mode: plan.then(|| "plan".into()),
            });
        }
        map.plan_mode = plan;
        let _ = self.events.send(SessionEventBody::StatusChanged {
            status: SessionStatus::Running,
        });
    }

    fn spawn_worker(self: &Arc<Self>, mut input: Input) {
        let shared = self.clone();
        tokio::spawn(async move {
            let session_id = shared.session_id().expect("checked before starting worker");
            loop {
                if let Err(err) = shared.apply_settings(&session_id).await {
                    let _ = shared.events.send(SessionEventBody::Error {
                        message: err.to_string(),
                    });
                }
                let response = {
                    let _guard = shared.status_lock.lock().unwrap();
                    if shared.user_stopped.load(Ordering::SeqCst) {
                        None
                    } else {
                        // 斜杠命令必须留在提示开头；取消上下文留给下一条普通消息。
                        let command = input.item.text.trim_start().starts_with('/');
                        let context = if command {
                            Vec::new()
                        } else {
                            std::mem::take(&mut shared.queue.lock().unwrap().interrupted)
                        };
                        super::context::prepend(context, &mut input.blocks);
                        if !command {
                            if let Some(text) = shared.instructions.lock().unwrap().take() {
                                input.blocks.insert(0, json!({"type":"text", "text":super::updates::wrap_instructions(text)}));
                            }
                        }
                        let response = shared.rpc.start_request(
                            "session/prompt",
                            json!({"sessionId":session_id, "prompt":input.blocks}),
                        );
                        shared.queue.lock().unwrap().in_flight = response.is_ok();
                        Some(response)
                    }
                };
                let result = match response {
                    Some(Ok((_, rx))) => rx.await.map_err(|_| AgentError::Closed),
                    Some(Err(err)) => Err(err),
                    None => Ok(Ok(json!({"stopReason":"cancelled"}))),
                };
                let _guard = shared.status_lock.lock().unwrap();
                let status = shared.finish_status(result);
                let stopped = shared.user_stopped.load(Ordering::SeqCst);
                if matches!(status, SessionStatus::Stopped | SessionStatus::Failed) {
                    let mut context = std::mem::take(&mut shared.queue.lock().unwrap().interrupted);
                    context.extend(input.blocks.clone());
                    let observed = shared.map.lock().unwrap().interrupted_context();
                    if !observed.is_empty() {
                        context.push(json!({"type":"text", "text":observed}));
                    }
                    shared.queue.lock().unwrap().interrupted = context;
                }
                let next = {
                    let mut queue = shared.queue.lock().unwrap();
                    let restart = queue.cancelling && status == SessionStatus::Stopped;
                    queue.in_flight = false;
                    queue.observed = false;
                    queue.cancelling = false;
                    if !stopped
                        && !shared.closed.load(Ordering::SeqCst)
                        && (status == SessionStatus::Completed || restart)
                    {
                        queue
                            .ready
                            .pop_front()
                            .map(|input| (input, true))
                            .or_else(|| {
                                (status == SessionStatus::Completed)
                                    .then(|| queue.held.pop_front())
                                    .flatten()
                                    .map(|input| (input, false))
                            })
                    } else {
                        // 停止或失败后保留所有尚未发出的消息，等待用户决定。
                        while let Some(input) = queue.ready.pop_back() {
                            queue.held.push_front(input);
                        }
                        None
                    }
                };
                shared.publish_queue();
                match next {
                    Some((next, continuation)) => {
                        shared.emit_dispatched(&next);
                        shared.begin_run(continuation);
                        input = next;
                    }
                    None => {
                        shared.busy.store(false, Ordering::SeqCst);
                        let _ = shared
                            .events
                            .send(SessionEventBody::StatusChanged { status });
                        break;
                    }
                }
            }
        });
    }

    /// 持有 status_lock。等当前 prompt 有实际活动再取消，避免连续引导把尚未进入上下文的消息吃掉。
    pub(super) fn cancel_for_steering(&self) -> Result<(), AgentError> {
        let mut queue = self.queue.lock().unwrap();
        if queue.ready.is_empty()
            || !queue.in_flight
            || !queue.observed
            || queue.cancelling
            || self.user_stopped.load(Ordering::SeqCst)
        {
            return Ok(());
        }
        self.rpc
            .notify("session/cancel", json!({"sessionId":self.session_id()}))?;
        queue.cancelling = true;
        drop(queue);
        self.cancel_prompts();
        Ok(())
    }

    fn cancel_prompts(&self) {
        for (id, (rpc_id, _)) in self.prompts.lock().unwrap().drain() {
            let _ = self.rpc.respond(&rpc_id, prompts::cancelled());
            let _ = self.events.send(SessionEventBody::PromptResolved {
                prompt_id: id,
                answer: "已中断".into(),
            });
        }
    }

    pub fn interrupt(&self) -> Result<(), AgentError> {
        let _guard = self.status_lock.lock().unwrap();
        self.ensure_open()?;
        if !self.busy.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.user_stopped.store(true, Ordering::SeqCst);
        self.cancel_prompts();
        if self.queue.lock().unwrap().in_flight {
            self.rpc
                .notify("session/cancel", json!({"sessionId":self.session_id()}))?;
        }
        Ok(())
    }

    pub(super) fn update_queued(&self, id: &str, mut input: Input) -> Result<(), AgentError> {
        let _guard = self.status_lock.lock().unwrap();
        self.ensure_open()?;
        let mut queue = self.queue.lock().unwrap();
        let slot = if let Some(index) = queue.ready.iter().position(|entry| entry.item.id == id) {
            &mut queue.ready[index]
        } else {
            queue
                .held
                .iter_mut()
                .find(|entry| entry.item.id == id)
                .ok_or_else(|| AgentError::Runtime(QUEUE_GONE.into()))?
        };
        input.item.id = slot.item.id.clone();
        input.item.client_id = slot.item.client_id.clone();
        *slot = input;
        drop(queue);
        self.publish_queue();
        Ok(())
    }

    pub(super) fn remove_queued(&self, id: &str) -> Result<(), AgentError> {
        let _guard = self.status_lock.lock().unwrap();
        self.ensure_open()?;
        let mut queue = self.queue.lock().unwrap();
        let before = queue.ready.len() + queue.held.len();
        queue.ready.retain(|entry| entry.item.id != id);
        queue.held.retain(|entry| entry.item.id != id);
        if before == queue.ready.len() + queue.held.len() {
            return Err(AgentError::Runtime(QUEUE_GONE.into()));
        }
        drop(queue);
        self.publish_queue();
        Ok(())
    }

    pub(super) fn flush_queued(self: &Arc<Self>, ids: Vec<String>) -> Result<(), AgentError> {
        let _guard = self.status_lock.lock().unwrap();
        self.ensure_open()?;
        if !self.prompts.lock().unwrap().is_empty() {
            return Err(AgentError::PendingPrompt);
        }
        let mut queue = self.queue.lock().unwrap();
        let mut selected = Vec::new();
        for id in ids.into_iter().filter(|id| !id.is_empty()) {
            if selected.contains(&id) {
                continue;
            }
            if !queue
                .held
                .iter()
                .chain(queue.ready.iter())
                .any(|entry| entry.item.id == id)
            {
                return Err(AgentError::Runtime(QUEUE_GONE.into()));
            }
            selected.push(id);
        }
        for id in selected {
            let input = if let Some(index) = queue.held.iter().position(|entry| entry.item.id == id)
            {
                queue.held.remove(index).unwrap()
            } else {
                let index = queue
                    .ready
                    .iter()
                    .position(|entry| entry.item.id == id)
                    .unwrap();
                queue.ready.remove(index).unwrap()
            };
            queue.ready.push_back(input);
        }
        let next = if !self.busy.load(Ordering::SeqCst) {
            queue.ready.pop_front()
        } else {
            None
        };
        drop(queue);
        self.publish_queue();
        if let Some(input) = next {
            self.emit_dispatched(&input);
            self.begin_run(false);
            self.spawn_worker(input);
        } else {
            self.cancel_for_steering()?;
        }
        Ok(())
    }

    pub(super) fn set_follow_up_queue_mode(&self, mode: &str) -> Result<(), AgentError> {
        let steer = match mode {
            "queue" => false,
            "steer" => true,
            _ => return Err(AgentError::Runtime("队列模式只能是 queue 或 steer".into())),
        };
        self.queue.lock().unwrap().steer = steer;
        Ok(())
    }

    fn publish_queue(&self) {
        let queue = self.queue.lock().unwrap();
        let items = queue
            .ready
            .iter()
            .chain(queue.held.iter())
            .map(|entry| entry.item.clone())
            .collect();
        let _ = self.events.send(SessionEventBody::QueueChanged { items });
    }

    fn emit_dispatched(&self, input: &Input) {
        if input.item.text.trim_start().starts_with('/') && input.item.images.is_empty() {
            return;
        }
        let _ = self.events.send(SessionEventBody::UserMessage {
            text: input.item.text.clone(),
            images: input.item.images.clone(),
            annotations: input.annotations,
            sender: None,
        });
    }
}
