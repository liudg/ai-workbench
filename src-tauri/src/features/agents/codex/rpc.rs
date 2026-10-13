//! 会话进程上的 JSON-RPC：请求、通知，以及 stdout 事件映射。

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::features::agents::AgentError;
use crate::models::{MessagePhase, PromptKind, PromptOption, SessionEventBody, SessionStatus};

const RPC_TIMEOUT: Duration = Duration::from_secs(45);

fn opens_turn(method: Option<&str>) -> bool {
    matches!(method, Some("turn/start" | "review/start"))
}

use super::history::{reasoning_text, take_chars, tool_event, tool_view, tool_visible, ToolView};
use super::prompts::{
    approval_question, error_text, parse_elicitation, parse_tool_questions, rpc_error_text,
};
use super::state::{emit, emit_status, ActivityBuf, Pending, Shared, StreamBuf};

impl Shared {
    pub(super) fn stop(&self) {
        if self.user_stop.swap(true, Ordering::SeqCst) {
            return;
        }
        self.closed.store(true, Ordering::SeqCst);
        self.turn_open.store(false, Ordering::SeqCst);
        if let Some(thread_id) = self.thread_id.lock().unwrap().clone() {
            let _ = self.write_method("turn/interrupt", json!({ "threadId": thread_id }));
        }
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.start_kill();
        }
        emit_status(&self.events, SessionStatus::Stopped);
    }

    pub(super) fn on_exit(&self) {
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
                let question = approval_question(method, &params);
                self.pending
                    .lock()
                    .unwrap()
                    .insert(prompt_id.clone(), Pending::Approval { rpc_id: id });
                emit(
                    &self.events,
                    SessionEventBody::Prompt {
                        prompt_id,
                        prompt_kind: PromptKind::Approval,
                        question,
                        options: vec![
                            PromptOption {
                                id: "approve".into(),
                                label: "允许".into(),
                                description: String::new(),
                                ..Default::default()
                            },
                            PromptOption {
                                id: "reject".into(),
                                label: "拒绝".into(),
                                description: String::new(),
                                ..Default::default()
                            },
                        ],
                        questions: Vec::new(),
                    },
                );
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
                if let Some(id) = params.pointer("/turn/id").and_then(Value::as_str) {
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
                self.drop_async_questions();
                if let Some(message) = params.pointer("/turn/error").and_then(error_text) {
                    self.plan_ready.store(false, Ordering::SeqCst);
                    if !self.reject_writer_conflict(&message) {
                        emit(&self.events, SessionEventBody::Error { message });
                    }
                } else {
                    self.maybe_offer_implement_plan();
                }
                self.poke_queue();
            }
            "thread/status/changed" => self.on_thread_status(params),
            "item/autoApprovalReview/completed" => self.on_auto_review_completed(params),
            "turn/diff/updated" => {
                let turn_id = params.get("turnId").and_then(Value::as_str).unwrap_or("");
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
                        crate::features::agents::changes::overlay_unified_diff(&existing, diff);
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
                if let Some(body) = super::gap::plan_steps_event(params) {
                    emit(&self.events, body);
                }
            }
            "thread/tokenUsage/updated" => {
                let ours = self.thread_id.lock().unwrap().clone();
                if ours.as_deref() == params.get("threadId").and_then(Value::as_str) {
                    *self.token_info.lock().unwrap() = super::tokens::parse_token_usage(params);
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
            let turn_id = self.current_turn_id();
            let files = crate::features::agents::changes::file_changes_from_codex(
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
            "enteredReviewMode" => {
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
            "exitedReviewMode" => {
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

    fn emit_normalized_changes(&self, turn_id: &str, updated: &[crate::models::FileChange]) {
        if turn_id.is_empty() || updated.is_empty() {
            return;
        }
        let mut all = self.remember_file_changes(turn_id, updated);
        let turn_diff = self.turn_diffs.lock().unwrap().get(turn_id).cloned();
        if let Some(diff) = turn_diff {
            let overlaid = crate::features::agents::changes::overlay_unified_diff(&all, &diff);
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

    fn emit_turn_files(&self, turn_id: &str, files: &[crate::models::FileChange]) {
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
                last_emit: Instant::now() - Duration::from_secs(1),
            });
        if !view.name.is_empty() {
            buf.name = view.name.clone();
        }
        if view.summary.trim().chars().count() >= buf.summary.trim().chars().count() {
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
        let files = crate::features::agents::changes::file_changes_from_codex(
            params.get("changes").unwrap_or(&Value::Null),
        );
        self.emit_normalized_changes(&turn_id, &files);
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
        },
        Some(item_id.to_string()),
    )
}
