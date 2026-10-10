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

use super::process::truncate;
use super::prompts::{approval_question, error_text, parse_tool_questions, rpc_error_text};
use super::resume::reasoning_text;
use super::state::{emit, emit_status, Pending, Shared, StreamBuf};

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
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.waiters.lock().unwrap().insert(id, tx);
        if !self.write_rpc(id, method, params) {
            self.waiters.lock().unwrap().remove(&id);
            return Err(AgentError::Runtime("无法向 Codex CLI 写入消息".into()));
        }
        match timeout(RPC_TIMEOUT, rx).await {
            Ok(Ok(message)) => {
                if let Some(err) = message.get("error") {
                    Err(AgentError::Runtime(rpc_error_text(err)))
                } else {
                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                }
            }
            _ => Err(AgentError::Runtime(format!("等待 Codex {method} 超时"))),
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
                        emit(
                            &self.events,
                            SessionEventBody::Error { message: text },
                        );
                        emit_status(&self.events, SessionStatus::Failed);
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
                            PromptOption { id: "approve".into(), label: "允许".into(), description: String::new() },
                            PromptOption { id: "reject".into(), label: "拒绝".into(), description: String::new() },
                        ],
                        questions: Vec::new(),
                    },
                );
                emit_status(&self.events, SessionStatus::NeedsInput);
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
                emit_status(&self.events, SessionStatus::NeedsInput);
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
                if let Some(id) = params.pointer("/turn/id").and_then(Value::as_str) {
                    let id = id.to_string();
                    *self.turn_id.lock().unwrap() = Some(id.clone());
                    *self.latest_turn_id.lock().unwrap() = Some(id.clone());
                    emit(
                        &self.events,
                        SessionEventBody::TurnAnchor { turn_id: id },
                    );
                }
                emit_status(&self.events, SessionStatus::Running);
            }
            "turn/completed" => {
                self.turn_open.store(false, Ordering::SeqCst);
                *self.turn_id.lock().unwrap() = None;
                if let Some(message) = params.pointer("/turn/error").and_then(error_text) {
                    self.plan_ready.store(false, Ordering::SeqCst);
                    if !self.reject_writer_conflict(&message) {
                        emit(&self.events, SessionEventBody::Error { message });
                        emit_status(&self.events, SessionStatus::Failed);
                    }
                } else if !self.maybe_offer_implement_plan()
                    && self.pending.lock().unwrap().is_empty()
                {
                    emit_status(&self.events, SessionStatus::Completed);
                }
                self.poke_queue();
            }
            "turn/diff/updated" => {
                let turn_id = params.get("turnId").and_then(Value::as_str).unwrap_or("");
                let diff = params.get("diff").and_then(Value::as_str).unwrap_or("");
                if !turn_id.is_empty() && !diff.is_empty() {
                    emit(
                        &self.events,
                        SessionEventBody::TurnDiff {
                            turn_id: turn_id.to_string(),
                            diff: diff.to_string(),
                        },
                    );
                }
            }
            "turn/plan/updated" => {
                if let Some(body) = super::gap::plan_steps_event(params) {
                    self.plan_ready.store(true, Ordering::SeqCst);
                    emit(&self.events, body);
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
                self.push_stream(item_id, delta, false);
            }
            "item/started" | "item/completed" => {
                let Some(item) = params.get("item") else { return };
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
                        emit_status(&self.events, SessionStatus::Failed);
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
            _ => {}
        }
    }

    pub(super) fn handle_item(&self, completed: bool, item: &Value) {
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
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    if self.consume_review_duplicate(text) {
                        return;
                    }
                }
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
                        self.push_stream(id, text, true);
                    } else if !text.is_empty() {
                        emit(
                            &self.events,
                            SessionEventBody::AgentMessage {
                                text: text.to_string(),
                                stream_id: None,
                                phase,
                            },
                        );
                    }
                }
            }
            "commandExecution" => {
                let command = item.get("command").and_then(Value::as_str).unwrap_or("");
                if !completed {
                    emit(
                        &self.events,
                        SessionEventBody::ToolCall {
                            name: "command".into(),
                            summary: truncate(command, 180),
                        },
                    );
                    return;
                }
                let status = item.get("status").and_then(Value::as_str).unwrap_or("");
                let exit = item
                    .get("exitCode")
                    .and_then(Value::as_i64)
                    .map(|code| format!("，退出码 {code}"))
                    .unwrap_or_default();
                let output = item
                    .get("aggregatedOutput")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let mut summary = format!("{command} → {status}{exit}");
                if !output.is_empty() {
                    summary.push('\n');
                    summary.push_str(&truncate(output, 240));
                }
                emit(
                    &self.events,
                    SessionEventBody::ToolCall {
                        name: "command".into(),
                        summary,
                    },
                );
            }
            "fileChange" if completed => {
                let changes = item
                    .get("changes")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter_map(|change| change.get("path").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("、")
                    })
                    .unwrap_or_default();
                let status = item.get("status").and_then(Value::as_str).unwrap_or("");
                emit(
                    &self.events,
                    SessionEventBody::ToolCall {
                        name: "apply_patch".into(),
                        summary: format!("{status} {changes}").trim().to_string(),
                    },
                );
            }
            "mcpToolCall" if !completed => {
                let tool = item.get("tool").and_then(Value::as_str).unwrap_or("mcp");
                let server = item.get("server").and_then(Value::as_str).unwrap_or("");
                emit(
                    &self.events,
                    SessionEventBody::ToolCall {
                        name: tool.to_string(),
                        summary: format!("MCP {server}"),
                    },
                );
            }
            "userMessage" if completed => self.note_user_item(item),
            "webSearch" if !completed => {
                let query = item.get("query").and_then(Value::as_str).unwrap_or("");
                emit(
                    &self.events,
                    SessionEventBody::ToolCall {
                        name: "web_search".into(),
                        summary: query.to_string(),
                    },
                );
            }
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
                        },
                    );
                }
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
                self.note_review_output(text);
                if !text.trim().is_empty() {
                    emit(&self.events, super::gap::parse_review_output(text));
                }
            }
            _ => {}
        }
    }

    pub(super) fn push_stream(&self, item_id: &str, piece: &str, replace: bool) {
        let mut streams = self.streams.lock().unwrap();
        let buf = streams.entry(item_id.to_string()).or_insert_with(|| StreamBuf {
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
}
