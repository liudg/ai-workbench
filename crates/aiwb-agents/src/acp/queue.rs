//! 本地待发队列。引导有两种：回合进行中再发 `session/prompt` 就算引导的 Agent 直接发；
//! 其余 cancel → 等旧 prompt 收尾 → 同 session 新 prompt。
//! 所有调度都持有 status_lock；只有一个 worker，旧响应不能结束新请求。

use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::rpc::RpcError;
use super::runtime::Shared;
use super::session::prompt_blocks;
use crate::protocol::fold_page_annotations;
use crate::{AgentError, TurnDelivery, UserTurn};
use aiwb_core::models::{QueuedTurn, SessionEventBody, SessionStatus};

const QUEUE_GONE: &str = "这条排队消息已经不在队列里";

pub(crate) struct Input {
    item: QueuedTurn,
    blocks: Vec<Value>,
    annotations: u32,
}

impl Input {
    pub(crate) fn new(turn: UserTurn) -> Result<Self, AgentError> {
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

impl QueueState {
    pub(crate) fn is_empty(&self) -> bool {
        self.held.is_empty() && self.ready.is_empty()
    }
}

#[derive(Default)]
pub(crate) struct QueueState {
    held: VecDeque<Input>,
    ready: VecDeque<Input>,
    steer: bool,
    pub(crate) in_flight: bool,
    pub(crate) observed: bool,
    pub(crate) cancelling: bool,
    /// 有的 Agent 不保留取消回合的消息；下次 prompt 显式带回已接收的输入和执行结果。
    interrupted: Vec<Value>,
    /// 已经发出的引导。前一个 prompt 的回包只说明它被接管了，回合以最后一个回包为准。
    steered: VecDeque<oneshot::Receiver<Result<Value, RpcError>>>,
}

impl Shared {
    pub(crate) fn submit(
        self: &Arc<Self>,
        input: Input,
        now: bool,
    ) -> Result<TurnDelivery, AgentError> {
        let _guard = self.status_lock.lock().unwrap();
        self.ensure_open()?;
        self.dialect.before_submit(&input.item.text);
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
            return Err(AgentError::Runtime(format!("{} 会话还没有建立", self.dialect.label())));
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
                        let context = if command || shared.dialect.keeps_cancelled_turns() {
                            Vec::new()
                        } else {
                            std::mem::take(&mut shared.queue.lock().unwrap().interrupted)
                        };
                        super::context::prepend(context, &mut input.blocks);
                        if !command {
                            if let Some(text) = shared.instructions.lock().unwrap().take() {
                                input.blocks.insert(0, json!({"type":"text", "text":super::updates::wrap_instructions(&text)}));
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
                let mut result = match response {
                    Some(Ok((_, rx))) => rx.await.map_err(|_| AgentError::Closed),
                    Some(Err(err)) => Err(err),
                    None => Ok(Ok(json!({"stopReason":"cancelled"}))),
                };
                loop {
                    shared.follow_steers(&mut result).await;
                    if !matches!(result, Ok(Ok(_))) {
                        break;
                    }
                    shared.dialect.settle_turn(&shared).await;
                    if !shared.has_steered() {
                        break;
                    }
                }
                let _guard = shared.status_lock.lock().unwrap();
                let status = shared.finish_status(result);
                let stopped = shared.user_stopped.load(Ordering::SeqCst);
                if matches!(status, SessionStatus::Stopped | SessionStatus::Failed)
                    && !shared.dialect.keeps_cancelled_turns()
                {
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
                        shared.dialect.turn_ended(&shared, status);
                        break;
                    }
                }
            }
        });
    }

    /// 持有 status_lock。等当前 prompt 有实际活动再取消，避免连续引导把尚未进入上下文的消息吃掉。
    pub(crate) fn cancel_for_steering(&self) -> Result<(), AgentError> {
        if self.dialect.steers_in_place() {
            return self.steer_in_place();
        }
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

    /// 回合以最后一个引导的回包为准。
    async fn follow_steers(&self, result: &mut Result<Result<Value, RpcError>, AgentError>) {
        loop {
            let steered = self.queue.lock().unwrap().steered.pop_front();
            let Some(rx) = steered else { return };
            *result = rx.await.map_err(|_| AgentError::Closed);
        }
    }

    /// 宿主自己发一条提示接回这一回合，不写用户气泡。回合已不在跑时什么也不做。
    pub(crate) fn nudge(&self, text: &str) -> Result<(), AgentError> {
        let _guard = self.status_lock.lock().unwrap();
        if !self.queue.lock().unwrap().in_flight {
            return Ok(());
        }
        let session_id = self.session_id().ok_or(AgentError::Closed)?;
        let (_, rx) = self.rpc.start_request(
            "session/prompt",
            json!({"sessionId":session_id, "prompt":[{"type":"text", "text":text}]}),
        )?;
        self.queue.lock().unwrap().steered.push_back(rx);
        Ok(())
    }

    pub(crate) fn has_steered(&self) -> bool {
        !self.queue.lock().unwrap().steered.is_empty()
    }

    /// 持有 status_lock。回合进行中就发 prompt，Agent 把它写进当前回合。
    fn steer_in_place(&self) -> Result<(), AgentError> {
        loop {
            let mut queue = self.queue.lock().unwrap();
            if !queue.in_flight || queue.cancelling || self.user_stopped.load(Ordering::SeqCst) {
                return Ok(());
            }
            let Some(input) = queue.ready.pop_front() else {
                return Ok(());
            };
            drop(queue);
            let session_id = self.session_id().ok_or(AgentError::Closed)?;
            let sent = self
                .rpc
                .start_request("session/prompt", json!({"sessionId":session_id, "prompt":input.blocks}));
            let (_, rx) = match sent {
                Ok(sent) => sent,
                Err(err) => {
                    self.queue.lock().unwrap().ready.push_front(input);
                    return Err(err);
                }
            };
            self.queue.lock().unwrap().steered.push_back(rx);
            self.emit_dispatched(&input);
            self.map.lock().unwrap().continue_turn();
            self.publish_queue();
        }
    }

    fn cancel_prompts(&self) {
        for (id, (rpc_id, pending)) in self.prompts.lock().unwrap().drain() {
            if !rpc_id.is_null() {
                let _ = self.rpc.respond(&rpc_id, pending.cancelled());
            }
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

    pub(crate) fn update_queued(&self, id: &str, mut input: Input) -> Result<(), AgentError> {
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

    pub(crate) fn remove_queued(&self, id: &str) -> Result<(), AgentError> {
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

    pub(crate) fn flush_queued(self: &Arc<Self>, ids: Vec<String>) -> Result<(), AgentError> {
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

    pub(crate) fn set_follow_up_queue_mode(&self, mode: &str) -> Result<(), AgentError> {
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
