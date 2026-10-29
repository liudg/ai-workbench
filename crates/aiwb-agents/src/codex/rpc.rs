//! 会话进程上的 JSON-RPC：请求、通知，以及 stdout 事件映射。

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::AgentError;
use aiwb_core::models::{MessagePhase, PromptKind, SessionEventBody, SessionStatus, ToolStatus};

const RPC_TIMEOUT: Duration = Duration::from_secs(45);

fn opens_turn(method: Option<&str>) -> bool {
    matches!(method, Some("turn/start" | "review/start"))
}

/// `turn/started` 的 id 在 `turn.id`。`turn/start` 回包、`turn/plan/updated` 也可能只给 `turnId`。
fn nested_turn_id(value: &Value) -> Option<&str> {
    value
        .pointer("/turn/id")
        .or_else(|| value.get("turnId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
}

fn turn_status_name(params: &Value) -> Option<&str> {
    params
        .pointer("/turn/status")
        .or_else(|| params.get("status"))
        .and_then(Value::as_str)
}

/// 只有正常结束才问要不要实施。`interrupted` / `failed`，以及带 error 的回包，都不再浮出确认卡。
fn turn_finished_cleanly(params: &Value) -> bool {
    if matches!(turn_status_name(params), Some("interrupted" | "failed")) {
        return false;
    }
    params.pointer("/turn/error").and_then(error_text).is_none()
}

use super::history::{reasoning_text, take_chars, tool_event, tool_view, tool_visible, ToolView};
use super::prompts::{
    error_text, parse_elicitation, parse_tool_questions, rpc_error_text,
};
use super::state::{emit, emit_status, ActivityBuf, Pending, Shared, StreamBuf};

impl Shared {
    pub(super) fn stop(&self) {
        if self.user_stop.swap(true, Ordering::SeqCst) {
            return;
        }
        self.closed.store(true, Ordering::SeqCst);
        self.turn_open.store(false, Ordering::SeqCst);
        let _ = self.write_turn_interrupt();
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.start_kill();
        }
        self.fail_waiters("已停止");
        emit_status(&self.events, SessionStatus::Stopped);
    }

    /// 进程被停掉或自己退出时，正在等的 `thread/start` 要马上失败，不能再干等超时。
    pub(super) fn fail_waiters(&self, message: &str) {
        let pending = std::mem::take(&mut *self.waiters.lock().unwrap());
        for (_, tx) in pending {
            let _ = tx.send(json!({
                "error": { "code": -1, "message": message }
            }));
        }
    }

    /// app-server `TurnInterruptParams` 要 `threadId` 和当前 `turnId`。
    /// 缺 turnId 时请求被拒，回合继续跑，计划结束后仍会浮出确认卡。
    pub(super) fn write_turn_interrupt(&self) -> Result<(), AgentError> {
        let thread_id = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| AgentError::Runtime("Codex 线程未建立".into()))?;
        let turn_id = self
            .turn_id
            .lock()
            .unwrap()
            .clone()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| AgentError::Runtime("当前没有可停止的回合".into()))?;
        if !self.write_method(
            "turn/interrupt",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
            }),
        ) {
            return Err(AgentError::Runtime("无法向 Codex CLI 写入消息".into()));
        }
        Ok(())
    }

    fn remember_turn_if_absent(&self, id: &str) {
        let id = id.trim();
        if id.is_empty() {
            return;
        }
        let mut slot = self.turn_id.lock().unwrap();
        if slot.as_deref().unwrap_or("").is_empty() {
            *slot = Some(id.to_string());
        }
    }

    pub(super) fn on_exit(&self) {
        self.fail_waiters("Codex CLI 进程已退出。");
        if self.user_stop.load(Ordering::SeqCst) || self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.turn_open.store(false, Ordering::SeqCst);
        // 只读打开的进程如果随后退出，历史还在。不要改写成「会话失败」。
        if self.read_only() {
            return;
        }
        emit(
            &self.events,
            SessionEventBody::Error {
                message: "Codex CLI 进程已退出。".into(),
            },
        );
        emit_status(&self.events, SessionStatus::Failed);
    }

    pub(super) async fn request(&self, method: &str, params: Value) -> Result<Value, AgentError> {
        self.request_raw(method, params)
            .await
            .map_err(|(_, message)| AgentError::Runtime(message))
    }

    /// 同 `request`，失败时保留 JSON-RPC 错误码。
    pub(super) async fn request_raw(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, (Option<i64>, String)> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.waiters.lock().unwrap().insert(id, tx);
        if !self.write_rpc(id, method, params) {
            self.waiters.lock().unwrap().remove(&id);
            return Err((None, "无法向 Codex CLI 写入消息".into()));
        }
        match timeout(RPC_TIMEOUT, rx).await {
            Ok(Ok(message)) => {
                if let Some(err) = message.get("error") {
                    Err((err.get("code").and_then(Value::as_i64), rpc_error_text(err)))
                } else {
                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                }
            }
            _ => Err((None, format!("等待 Codex {method} 超时"))),
        }
    }

    pub(super) fn write_method(&self, method: &str, params: Value) -> bool {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.rpc_methods
            .lock()
            .unwrap()
            .insert(id, method.to_string());
        self.write_rpc(id, method, params)
    }

    pub(super) fn notify(&self, method: &str, params: Value) -> bool {
        let line = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        })
        .to_string();
        self.out.send(line).is_ok()
    }

    pub(super) fn write_rpc(&self, id: u64, method: &str, params: Value) -> bool {
        let line = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        })
        .to_string();
        self.out.send(line).is_ok()
    }

    pub(super) fn respond(&self, id: u64, result: Value) {
        let line = json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string();
        let _ = self.out.send(line);
    }

    pub(super) fn respond_error(&self, id: u64, message: &str) {
        let line = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": message }
        })
        .to_string();
        let _ = self.out.send(line);
    }

    pub(super) fn handle_line(&self, line: &str) {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            if message.get("method").is_some() {
                self.handle_server_request(id, &message);
                return;
            }
            if let Some(waiter) = self.waiters.lock().unwrap().remove(&id) {
                let _ = waiter.send(message);
            } else {
                let method = self.rpc_methods.lock().unwrap().remove(&id);
                if let Some(err) = message.get("error") {
                    let text = rpc_error_text(err);
                    if self.reject_writer_conflict(&text) {
                        if opens_turn(method.as_deref()) {
                            self.turn_open.store(false, Ordering::SeqCst);
                        }
                    } else if opens_turn(method.as_deref()) {
                        self.turn_open.store(false, Ordering::SeqCst);
                        emit(&self.events, SessionEventBody::Error { message: text });
                    } else {
                        let label = method.unwrap_or_else(|| "请求".into());
                        emit(
                            &self.events,
                            SessionEventBody::System {
                                text: format!("Codex {label} 失败：{text}"),
                            },
                        );
                    }
                } else if opens_turn(method.as_deref()) {
                    if let Some(id) = message.get("result").and_then(nested_turn_id) {
                        self.remember_turn_if_absent(id);
                    }
                }
            }
            return;
        }
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            self.handle_notification(method, &params);
        }
    }

    pub(super) fn handle_server_request(&self, id: u64, message: &Value) {
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let prompt_id = id.to_string();
        match method {
            "currentTime/read" => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                self.respond(id, json!({ "currentTimeAt": now }));
            }
            "item/tool/call" => {
                let tool = params
                    .pointer("/tool")
                    .and_then(Value::as_str)
                    .or_else(|| params.get("name").and_then(Value::as_str))
                    .unwrap_or("tool");
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: format!("已拒绝客户端工具 {tool}。Codex 自己的命令和补丁仍走审批。"),
                    },
                );
                self.respond(
                    id,
                    json!({
                        "success": false,
                        "contentItems": [{
                            "type": "inputText",
                            "text": "ai-workbench 不执行客户端动态工具。"
                        }]
                    }),
                );
            }
            "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval" => {
                let params = if method == "item/fileChange/requestApproval" {
                    let cached = params.get("itemId").and_then(Value::as_str).and_then(|id| {
                        self.file_items.lock().unwrap().get(id).cloned()
                    });
                    super::approval::merge_file_changes(&params, cached.as_ref())
                } else {
                    params
                };
                match super::approval::approval_from_request(method, &params) {
                    super::approval::ApprovalFromRequest::AutoDeny(result) => {
                        self.respond(id, result);
                    }
                    super::approval::ApprovalFromRequest::Prompt(prompt) => {
                        self.pending.lock().unwrap().insert(
                            prompt_id.clone(),
                            Pending::Approval {
                                rpc_id: id,
                                reply: prompt.reply,
                            },
                        );
                        emit(
                            &self.events,
                            SessionEventBody::Prompt {
                                prompt_id,
                                prompt_kind: PromptKind::Approval,
                                question: prompt.question,
                                options: prompt.options,
                                questions: Vec::new(),
                                header: prompt.header,
                                subtitle: prompt.subtitle,
                                body: prompt.body,
                                body_kind: prompt.body_kind,
                                reason: prompt.reason,
                            },
                        );
                    }
                }
            }
            "elicitation/request" | "mcpServer/elicitation/request" => {
                let (question, questions) = parse_elicitation(&params);
                self.pending.lock().unwrap().insert(
                    prompt_id.clone(),
                    Pending::Elicitation {
                        rpc_id: id,
                        questions: questions.clone(),
                    },
                );
                emit(
                    &self.events,
                    SessionEventBody::Prompt {
                        prompt_id,
                        prompt_kind: PromptKind::Elicitation,
                        question,
                        options: Vec::new(),
                        questions,
                        header: String::new(),
                        subtitle: String::new(),
                        body: String::new(),
                        body_kind: String::new(),
                        reason: String::new(),
                    },
                );
            }
            "item/tool/requestUserInput" => {
                let questions = parse_tool_questions(&params);
                if questions.is_empty() {
                    // 没有题目：按跳过回复，让工具立即返回
                    self.respond(id, json!({ "answers": {} }));
                    return;
                }
                let first = questions[0].question.clone();
                self.pending.lock().unwrap().insert(
                    prompt_id.clone(),
                    Pending::UserInput {
                        rpc_id: id,
                        questions: questions.clone(),
                    },
                );
                emit(
                    &self.events,
                    SessionEventBody::Prompt {
                        prompt_id,
                        prompt_kind: PromptKind::Questions,
                        question: first,
                        options: Vec::new(),
                        questions,
                        header: String::new(),
                        subtitle: String::new(),
                        body: String::new(),
                        body_kind: String::new(),
                        reason: String::new(),
                    },
                );
            }
            _ => {
                self.respond_error(id, "ai-workbench 未处理该 Codex 请求");
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: format!("已跳过 Codex 请求 {method}。"),
                    },
                );
            }
        }
    }

    pub(super) fn handle_notification(&self, method: &str, params: &Value) {
        match method {
            "turn/started" => {
                self.turn_open.store(true, Ordering::SeqCst);
                self.plan_ready.store(false, Ordering::SeqCst);
                if let Some(id) = nested_turn_id(params) {
                    let id = id.to_string();
                    *self.turn_id.lock().unwrap() = Some(id.clone());
                    emit(
                        &self.events,
                        SessionEventBody::TurnAnchor {
                            turn_id: id,
                            mode: self.plan_marker(),
                        },
                    );
                }
            }
            "turn/completed" => {
                self.turn_open.store(false, Ordering::SeqCst);
                *self.turn_id.lock().unwrap() = None;
                if turn_finished_cleanly(params) {
                    self.maybe_offer_implement_plan();
                } else {
                    self.plan_ready.store(false, Ordering::SeqCst);
                    // 用户停止的回合是 interrupted。取消不是失败，不画红条。
                    if turn_status_name(params) != Some("interrupted") {
                        if let Some(message) = params.pointer("/turn/error").and_then(error_text) {
                            if !self.reject_writer_conflict(&message) {
                                emit(&self.events, SessionEventBody::Error { message });
                            }
                        }
                    }
                }
                self.poke_queue();
            }
            "thread/status/changed" => self.on_thread_status(params),
            "item/autoApprovalReview/completed" => self.on_auto_review_completed(params),
            "turn/diff/updated" => {
                let turn_id = params.get("turnId").and_then(Value::as_str).unwrap_or("");
                self.remember_turn_if_absent(turn_id);
                let diff = params.get("diff").and_then(Value::as_str).unwrap_or("");
                if !turn_id.is_empty() && !diff.is_empty() {
                    self.remember_turn_diff(turn_id, diff);
                    emit(
                        &self.events,
                        SessionEventBody::TurnDiff {
                            turn_id: turn_id.to_string(),
                            diff: diff.to_string(),
                        },
                    );
                    let existing = self
                        .turn_files
                        .lock()
                        .unwrap()
                        .get(turn_id)
                        .cloned()
                        .unwrap_or_default();
                    let overlaid =
                        crate::changes::overlay_unified_diff(&existing, diff);
                    if overlaid != existing {
                        self.turn_files
                            .lock()
                            .unwrap()
                            .insert(turn_id.to_string(), overlaid.clone());
                        self.emit_turn_files(turn_id, &overlaid);
                    }
                }
            }
            "turn/plan/updated" => {
                if let Some(id) = params.get("turnId").and_then(Value::as_str) {
                    self.remember_turn_if_absent(id);
                }
                if let Some(body) = super::gap::plan_steps_event(params) {
                    emit(&self.events, body);
                }
            }
            "thread/tokenUsage/updated" => {
                let ours = self.thread_id.lock().unwrap().clone();
                if ours.as_deref() == params.get("threadId").and_then(Value::as_str) {
                    if let Some(info) = super::tokens::parse_token_usage(params) {
                        let body = super::usage::snapshot_from_info(&info);
                        *self.token_info.lock().unwrap() = Some(info);
                        emit(&self.events, body);
                    }
                }
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                let Some(item_id) = params.get("itemId").and_then(Value::as_str) else {
                    return;
                };
                let delta = params.get("delta").and_then(Value::as_str).unwrap_or("");
                if !delta.is_empty() {
                    self.push_thinking(item_id, delta, false);
                }
            }
            "item/agentMessage/delta" => {
                let Some(item_id) = params.get("itemId").and_then(Value::as_str) else {
                    return;
                };
                if self.question_items.lock().unwrap().contains(item_id) {
                    return;
                }
                let delta = params.get("delta").and_then(Value::as_str).unwrap_or("");
                self.push_stream(item_id, delta, false, None);
            }
            "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
                self.append_activity_delta(params, method.contains("fileChange"));
            }
            "item/fileChange/patchUpdated" => self.replace_patch(params),
            "item/started" | "item/completed" => {
                let Some(item) = params.get("item") else {
                    return;
                };
                self.handle_item(method == "item/completed", item);
            }
            "error" => {
                if let Some(message) = params.get("message").and_then(Value::as_str) {
                    self.turn_open.store(false, Ordering::SeqCst);
                    if !self.reject_writer_conflict(message) {
                        emit(
                            &self.events,
                            SessionEventBody::Error {
                                message: message.to_string(),
                            },
                        );
                    }
                }
            }
            "thread/queue/changed" => self.poke_queue(),
            "thread/compacted" => {
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: "Codex 已压缩当前线程的上下文。".into(),
                    },
                );
            }
            "thread/goal/updated" => {
                if self.thread_matches(params) {
                    emit(
                        &self.events,
                        super::turn::goal_snapshot_event(params.get("goal")),
                    );
                }
            }
            "thread/goal/cleared" => {
                if self.thread_matches(params) {
                    emit(&self.events, super::turn::goal_snapshot_event(None));
                }
            }
            _ => {}
        }
    }

    fn thread_matches(&self, params: &Value) -> bool {
        let ours = self.thread_id.lock().unwrap().clone().unwrap_or_default();
        if ours.is_empty() {
            return false;
        }
        params.get("threadId").and_then(Value::as_str) == Some(ours.as_str())
    }

    pub(super) fn handle_item(&self, completed: bool, item: &Value) {
        if item.get("type").and_then(Value::as_str) == Some("fileChange") {
            if let Some(id) = item.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) {
                self.file_items
                    .lock()
                    .unwrap()
                    .insert(id.to_string(), item.clone());
            }
            let turn_id = self.current_turn_id();
            let files = crate::changes::file_changes_from_codex(
                item.get("changes").unwrap_or(&Value::Null),
            );
            if !files.is_empty() {
                self.emit_normalized_changes(&turn_id, &files);
            }
            return;
        }
        if tool_view(item).is_some() {
            self.upsert_tool(completed, item);
            return;
        }
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
        let id = item.get("id").and_then(Value::as_str).unwrap_or("");
        match kind {
            "reasoning" => {
                let text = reasoning_text(item);
                if id.is_empty() {
                    let shown = if text.trim().is_empty() {
                        if completed {
                            return;
                        }
                        "思考中…".to_string()
                    } else {
                        text
                    };
                    emit(
                        &self.events,
                        SessionEventBody::Thinking {
                            text: shown,
                            stream_id: None,
                        },
                    );
                    return;
                }
                if text.trim().is_empty() {
                    if !completed {
                        self.push_thinking(id, "思考中…", true);
                    }
                    return;
                }
                self.push_thinking(id, &text, true);
            }
            "agentMessage" => {
                if self.maybe_emit_async_questions(id, item) {
                    return;
                }
                let dedupe_of = item
                    .get("text")
                    .and_then(Value::as_str)
                    .and_then(|text| self.take_review_duplicate(text));
                let phase = MessagePhase::parse(item.get("phase").and_then(Value::as_str));
                if !id.is_empty() {
                    if let Some(phase) = phase {
                        self.message_phases
                            .lock()
                            .unwrap()
                            .insert(id.to_string(), phase);
                    }
                }
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    if !id.is_empty() {
                        self.streams.lock().unwrap().insert(
                            id.to_string(),
                            StreamBuf {
                                text: String::new(),
                                last_emit: Instant::now(),
                            },
                        );
                        self.push_stream(id, text, true, dedupe_of.clone());
                    } else if !text.is_empty() {
                        emit(
                            &self.events,
                            SessionEventBody::AgentMessage {
                                text: text.to_string(),
                                stream_id: None,
                                phase,
                                mode: self.plan_marker(),
                                dedupe_of,
                            },
                        );
                    }
                }
            }
            "userMessage" if completed => self.note_user_item(item),
            "plan" if completed => {
                let text = item.get("text").and_then(Value::as_str).unwrap_or("");
                if !text.is_empty() {
                    emit(
                        &self.events,
                        SessionEventBody::PlanText {
                            text: text.to_string(),
                            stream_id: if id.is_empty() {
                                None
                            } else {
                                Some(id.to_string())
                            },
                            mode: Some("plan".into()),
                        },
                    );
                }
                // TUI `on_plan_item_completed`：记下计划正文，并标记本回合出现过 plan item。
                if !text.trim().is_empty() {
                    *self.latest_plan.lock().unwrap() = Some(text.to_string());
                }
                self.plan_ready.store(true, Ordering::SeqCst);
            }
            // `item/started` 和 `item/completed` 都会进来。审查正文只在完成时写一次。
            "enteredReviewMode" if completed => {
                let text = item.get("review").and_then(Value::as_str).unwrap_or("");
                if !text.is_empty() {
                    emit(
                        &self.events,
                        SessionEventBody::ReviewNote {
                            text: text.to_string(),
                        },
                    );
                }
            }
            "exitedReviewMode" if completed => {
                let text = item.get("review").and_then(Value::as_str).unwrap_or("");
                let review_id = item.get("id").and_then(Value::as_str).unwrap_or("review");
                self.note_review_output(review_id, text);
                if !text.trim().is_empty() {
                    emit(&self.events, super::gap::parse_review_output(text));
                }
            }
            _ => {}
        }
    }

    /// `stream_id` 用协议里的 item id。会话日志按这个 id 覆盖整段会话，固定值会把后一轮写进前一轮的气泡。
    pub(super) fn push_stream(
        &self,
        item_id: &str,
        piece: &str,
        replace: bool,
        dedupe_of: Option<String>,
    ) {
        let mut streams = self.streams.lock().unwrap();
        let buf = streams
            .entry(item_id.to_string())
            .or_insert_with(|| StreamBuf {
                text: String::new(),
                last_emit: Instant::now() - Duration::from_secs(1),
            });
        if replace {
            buf.text = piece.to_string();
        } else {
            buf.text.push_str(piece);
        }
        let due = replace
            || buf.last_emit.elapsed() >= Duration::from_millis(80)
            || buf.text.chars().count() % 48 < piece.chars().count();
        if !due || buf.text.is_empty() {
            return;
        }
        buf.last_emit = Instant::now();
        let text = buf.text.clone();
        drop(streams);
        let phase = self.message_phases.lock().unwrap().get(item_id).copied();
        emit(
            &self.events,
            SessionEventBody::AgentMessage {
                text,
                stream_id: Some(item_id.to_string()),
                phase,
                mode: self.plan_marker(),
                dedupe_of,
            },
        );
    }

    fn current_turn_id(&self) -> String {
        self.turn_id.lock().unwrap().clone().unwrap_or_default()
    }

    fn emit_normalized_changes(&self, turn_id: &str, updated: &[aiwb_core::models::FileChange]) {
        if turn_id.is_empty() || updated.is_empty() {
            return;
        }
        let mut all = self.remember_file_changes(turn_id, updated);
        let turn_diff = self.turn_diffs.lock().unwrap().get(turn_id).cloned();
        if let Some(diff) = turn_diff {
            let overlaid = crate::changes::overlay_unified_diff(&all, &diff);
            if overlaid != all {
                all = overlaid;
                self.turn_files
                    .lock()
                    .unwrap()
                    .insert(turn_id.to_string(), all.clone());
            }
        }
        self.emit_turn_files(turn_id, &all);
    }

    fn emit_turn_files(&self, turn_id: &str, files: &[aiwb_core::models::FileChange]) {
        if turn_id.is_empty() || files.is_empty() {
            return;
        }
        for file in files {
            emit(
                &self.events,
                SessionEventBody::FileChange {
                    turn_id: turn_id.to_string(),
                    path: file.path.clone(),
                    status: file.status,
                    added: file.added,
                    removed: file.removed,
                    diff: file.diff.clone(),
                },
            );
        }
        emit(
            &self.events,
            SessionEventBody::TurnChanges {
                turn_id: turn_id.to_string(),
                files: files.to_vec(),
            },
        );
    }

    /// 思考和正文一样，按 item id 分气泡，不共用一个固定 `stream_id`。
    pub(super) fn push_thinking(&self, item_id: &str, piece: &str, replace: bool) {
        let key = format!("think:{item_id}");
        let mut streams = self.streams.lock().unwrap();
        if replace && piece == "思考中…" {
            if let Some(buf) = streams.get(&key) {
                if !buf.text.is_empty() && buf.text != "思考中…" {
                    return;
                }
            }
        }
        let existed = streams.contains_key(&key);
        let buf = streams.entry(key).or_insert_with(|| StreamBuf {
            text: String::new(),
            last_emit: Instant::now() - Duration::from_secs(1),
        });
        if replace || buf.text.is_empty() || buf.text == "思考中…" {
            buf.text = piece.to_string();
        } else {
            buf.text.push_str(piece);
        }
        let due = replace || !existed || buf.last_emit.elapsed() >= Duration::from_millis(80);
        if !due || buf.text.is_empty() {
            return;
        }
        buf.last_emit = Instant::now();
        let text = buf.text.clone();
        drop(streams);
        emit(
            &self.events,
            SessionEventBody::Thinking {
                text,
                stream_id: Some(item_id.to_string()),
            },
        );
    }

    fn upsert_tool(&self, completed: bool, item: &Value) {
        let Some(mut view) = tool_view(item) else {
            return;
        };
        let id = item.get("id").and_then(Value::as_str).unwrap_or("");
        view.status = settled_status(completed, view.status);
        if id.is_empty() {
            if completed && tool_visible(&view) {
                emit(&self.events, tool_event(view, None));
            }
            return;
        }
        let mut activity = self.activity.lock().unwrap();
        let buf = activity
            .entry(id.to_string())
            .or_insert_with(|| ActivityBuf {
                name: String::new(),
                summary: String::new(),
                detail: String::new(),
                images: Vec::new(),
                status: ToolStatus::Running,
                exit_code: None,
                last_emit: Instant::now() - Duration::from_secs(1),
            });
        if !view.name.is_empty() {
            buf.name = view.name.clone();
        }
        buf.status = view.status;
        if view.exit_code.is_some() {
            buf.exit_code = view.exit_code;
        }
        if view.name == "image_generation"
            || view.summary.trim().chars().count() >= buf.summary.trim().chars().count()
        {
            buf.summary = std::mem::take(&mut view.summary);
        }
        if completed {
            if view.detail.chars().count() >= buf.detail.chars().count() {
                buf.detail = std::mem::take(&mut view.detail);
            }
        } else if buf.detail.is_empty() {
            buf.detail = std::mem::take(&mut view.detail);
        }
        if !view.images.is_empty() {
            buf.images = std::mem::take(&mut view.images);
        }
        let body = activity_event(id, buf);
        let visible = match &body {
            SessionEventBody::ToolCall {
                summary,
                detail,
                images,
                ..
            } => !summary.trim().is_empty() || !detail.trim().is_empty() || !images.is_empty(),
            _ => false,
        };
        buf.last_emit = Instant::now();
        drop(activity);
        if visible {
            emit(&self.events, body);
        }
    }

    fn append_activity_delta(&self, params: &Value, file: bool) {
        if file {
            return;
        }
        let Some(item_id) = params.get("itemId").and_then(Value::as_str) else {
            return;
        };
        let delta = params.get("delta").and_then(Value::as_str).unwrap_or("");
        if delta.is_empty() {
            return;
        }
        let mut activity = self.activity.lock().unwrap();
        let buf = activity
            .entry(item_id.to_string())
            .or_insert_with(|| ActivityBuf {
                name: "command".into(),
                summary: String::new(),
                detail: String::new(),
                images: Vec::new(),
                status: ToolStatus::Running,
                exit_code: None,
                last_emit: Instant::now() - Duration::from_secs(1),
            });
        buf.detail.push_str(delta);
        if buf.detail.chars().count() > 20_000 {
            let capped = take_chars(&buf.detail, 20_000);
            buf.detail = capped;
        }
        let due = buf.last_emit.elapsed() >= Duration::from_millis(80);
        if !due {
            return;
        }
        buf.last_emit = Instant::now();
        let body = activity_event(item_id, buf);
        drop(activity);
        emit(&self.events, body);
    }

    fn replace_patch(&self, params: &Value) {
        let turn_id = params
            .get("turnId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| self.current_turn_id());
        let files = crate::changes::file_changes_from_codex(
            params.get("changes").unwrap_or(&Value::Null),
        );
        self.emit_normalized_changes(&turn_id, &files);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiwb_core::models::PromptKind;

    fn harness() -> (
        Shared,
        tokio::sync::mpsc::UnboundedReceiver<String>,
        tokio::sync::mpsc::UnboundedReceiver<SessionEventBody>,
    ) {
        let (events_tx, events_rx) = tokio::sync::mpsc::unbounded_channel();
        let (out_tx, out_rx) = tokio::sync::mpsc::unbounded_channel();
        (Shared::for_test(events_tx, out_tx), out_rx, events_rx)
    }

    fn rpc_line(line: &str) -> Value {
        serde_json::from_str(line).expect("rpc json")
    }

    fn drain(
        events: &mut tokio::sync::mpsc::UnboundedReceiver<SessionEventBody>,
    ) -> Vec<SessionEventBody> {
        let mut bodies = Vec::new();
        while let Ok(body) = events.try_recv() {
            bodies.push(body);
        }
        bodies
    }

    #[test]
    fn command_status_follows_started_and_completed() {
        let (shared, _out, mut events) = harness();
        let command = |status: &str, exit: Value| {
            json!({ "item": {
                "type": "commandExecution",
                "id": "cmd_1",
                "command": "pnpm test",
                "status": status,
                "exitCode": exit,
                "aggregatedOutput": "1 failed",
            }})
        };
        shared.handle_notification("item/started", &command("inProgress", Value::Null));
        shared.handle_notification(
            "item/commandExecution/outputDelta",
            &json!({ "itemId": "cmd_1", "delta": "running
" }),
        );
        shared.handle_notification("item/completed", &command("completed", json!(1)));
        let calls: Vec<_> = drain(&mut events)
            .into_iter()
            .filter_map(|body| match body {
                SessionEventBody::ToolCall {
                    summary,
                    status,
                    exit_code,
                    ..
                } => Some((summary, status, exit_code)),
                _ => None,
            })
            .collect();
        assert!(calls.len() >= 2, "{calls:?}");
        assert!(calls[..calls.len() - 1]
            .iter()
            .all(|(_, status, _)| *status == ToolStatus::Running));
        let (summary, status, exit_code) = calls.last().unwrap();
        assert_eq!(summary, "pnpm test");
        assert_eq!(*status, ToolStatus::Failed);
        assert_eq!(*exit_code, Some(1));
    }

    #[test]
    fn completed_without_status_is_not_left_running() {
        assert_eq!(settled_status(true, ToolStatus::Running), ToolStatus::Completed);
        assert_eq!(settled_status(false, ToolStatus::Completed), ToolStatus::Running);
        assert_eq!(settled_status(true, ToolStatus::Failed), ToolStatus::Failed);
    }

    #[test]
    fn interrupt_sends_the_active_turn_id() {
        let (shared, mut out, _events) = harness();
        *shared.thread_id.lock().unwrap() = Some("thr_1".into());
        shared.handle_notification(
            "turn/started",
            &json!({
                "threadId": "thr_1",
                "turn": { "id": "turn_9", "status": "inProgress", "items": [] }
            }),
        );
        shared.write_turn_interrupt().expect("interrupt");
        let value = rpc_line(&out.try_recv().expect("interrupt line"));
        assert_eq!(value["method"], "turn/interrupt");
        assert_eq!(value["params"]["threadId"], "thr_1");
        assert_eq!(value["params"]["turnId"], "turn_9");
        assert!(out.try_recv().is_err());
    }

    #[test]
    fn plan_turn_id_is_kept_when_started_omits_the_nested_id() {
        let (shared, mut out, _events) = harness();
        *shared.thread_id.lock().unwrap() = Some("thr_1".into());
        assert!(shared.write_method("turn/start", json!({ "threadId": "thr_1" })));
        let _ = out.try_recv();
        shared.handle_line(
            r#"{"jsonrpc":"2.0","id":1,"result":{"turn":{"id":"turn_from_start","status":"inProgress"}}}"#,
        );
        shared.handle_notification(
            "turn/started",
            &json!({ "threadId": "thr_1", "turn": { "status": "inProgress" } }),
        );
        assert_eq!(
            shared.turn_id.lock().unwrap().as_deref(),
            Some("turn_from_start")
        );
        shared.handle_notification(
            "turn/plan/updated",
            &json!({
                "turnId": "turn_plan",
                "plan": [{ "step": "改解析", "status": "pending" }]
            }),
        );
        assert_eq!(
            shared.turn_id.lock().unwrap().as_deref(),
            Some("turn_from_start"),
            "a later plan update must not replace the turn already recorded"
        );

        let (bare, mut bare_out, _) = harness();
        *bare.thread_id.lock().unwrap() = Some("thr_2".into());
        bare.handle_notification(
            "turn/plan/updated",
            &json!({
                "turnId": "turn_plan",
                "plan": [{ "step": "改解析", "status": "pending" }]
            }),
        );
        bare.write_turn_interrupt().expect("interrupt");
        let value = rpc_line(&bare_out.try_recv().expect("interrupt line"));
        assert_eq!(value["params"]["turnId"], "turn_plan");
    }

    #[test]
    fn missing_turn_id_does_not_send_an_invalid_interrupt() {
        let (shared, mut out, _events) = harness();
        *shared.thread_id.lock().unwrap() = Some("thr_1".into());
        let err = shared.write_turn_interrupt().expect_err("no turn");
        assert!(err.to_string().contains("当前没有可停止的回合"));
        assert!(out.try_recv().is_err());
    }

    #[test]
    fn stopped_or_failed_plan_turn_does_not_offer_implementation() {
        let (shared, _out, mut events) = harness();
        *shared.thread_id.lock().unwrap() = Some("thr_1".into());
        *shared.collaboration.lock().unwrap() = super::super::state::Collaboration::Plan;
        shared.handle_notification(
            "turn/started",
            &json!({ "turn": { "id": "turn_plan", "status": "inProgress" } }),
        );
        shared.handle_notification(
            "item/completed",
            &json!({ "item": { "type": "plan", "id": "p1", "text": "1. 改解析" } }),
        );
        shared.handle_notification(
            "turn/completed",
            &json!({
                "turn": { "id": "turn_plan", "status": "interrupted", "error": null }
            }),
        );
        assert!(!drain(&mut events).iter().any(|body| matches!(
            body,
            SessionEventBody::Prompt {
                prompt_kind: PromptKind::Choice,
                ..
            }
        )));

        shared.handle_notification(
            "turn/started",
            &json!({ "turn": { "id": "turn_fail", "status": "inProgress" } }),
        );
        shared.handle_notification(
            "item/completed",
            &json!({ "item": { "type": "plan", "id": "p2", "text": "1. 改解析" } }),
        );
        shared.handle_notification(
            "turn/completed",
            &json!({
                "turn": {
                    "id": "turn_fail",
                    "status": "failed",
                    "error": { "message": "模型超时" }
                }
            }),
        );
        let failed = drain(&mut events);
        assert!(failed.iter().any(|body| matches!(
            body,
            SessionEventBody::Error { message } if message.contains("模型超时")
        )));
        assert!(!failed
            .iter()
            .any(|body| matches!(body, SessionEventBody::Prompt { .. })));

        shared.handle_notification(
            "turn/started",
            &json!({ "turn": { "id": "turn_ok", "status": "inProgress" } }),
        );
        shared.handle_notification(
            "item/completed",
            &json!({ "item": { "type": "plan", "id": "p3", "text": "1. 改解析" } }),
        );
        shared.handle_notification(
            "turn/completed",
            &json!({
                "turn": { "id": "turn_ok", "status": "completed", "error": null }
            }),
        );
        assert!(drain(&mut events).iter().any(|body| matches!(
            body,
            SessionEventBody::Prompt { question, .. } if question == "实施此计划？"
        )));
    }

    #[test]
    fn review_mode_items_are_recorded_only_when_completed() {
        let (shared, _out, mut events) = harness();
        let entered = json!({
            "item": {
                "type": "enteredReviewMode",
                "id": "rev-in",
                "review": "看未提交改动"
            }
        });
        shared.handle_notification("item/started", &entered);
        assert!(
            drain(&mut events).is_empty(),
            "item/started must not write a review note"
        );
        shared.handle_notification("item/completed", &entered);
        let notes = drain(&mut events);
        assert_eq!(notes.len(), 1);
        assert!(matches!(
            &notes[0],
            SessionEventBody::ReviewNote { text } if text == "看未提交改动"
        ));

        let exited = json!({
            "item": {
                "type": "exitedReviewMode",
                "id": "rev-out",
                "review": "没有问题"
            }
        });
        shared.handle_notification("item/started", &exited);
        assert!(
            drain(&mut events).is_empty(),
            "item/started must not write review findings"
        );
        shared.handle_notification("item/completed", &exited);
        let findings = drain(&mut events);
        assert_eq!(findings.len(), 1);
        assert!(matches!(
            &findings[0],
            SessionEventBody::ReviewFindings { summary, .. } if summary == "没有问题"
        ));

        shared.handle_notification(
            "item/completed",
            &json!({
                "item": { "type": "agentMessage", "id": "msg-1", "text": "没有问题" }
            }),
        );
        let messages = drain(&mut events);
        assert!(matches!(
            &messages[0],
            SessionEventBody::AgentMessage { dedupe_of: Some(id), .. } if id == "rev-out"
        ));
    }
}

fn activity_event(item_id: &str, buf: &ActivityBuf) -> SessionEventBody {
    tool_event(
        ToolView {
            name: if buf.name.is_empty() {
                "command".into()
            } else {
                buf.name.clone()
            },
            summary: buf.summary.clone(),
            detail: buf.detail.clone(),
            images: buf.images.clone(),
            status: buf.status,
            exit_code: buf.exit_code,
        },
        Some(item_id.to_string()),
    )
}

/// `item/started` 一律算进行中；`item/completed` 里协议没给结束状态时按完成算。
fn settled_status(completed: bool, reported: ToolStatus) -> ToolStatus {
    match (completed, reported) {
        (false, _) => ToolStatus::Running,
        (true, ToolStatus::Running) => ToolStatus::Completed,
        (true, status) => status,
    }
}
