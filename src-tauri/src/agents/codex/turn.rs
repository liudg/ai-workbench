//! 回合、线程恢复、斜杠命令执行。

use std::sync::atomic::Ordering;

use serde_json::{json, Value};
use tokio::process::Command;

use crate::agents::AgentError;
use crate::encoding::{apply_utf8_env, decode_child_bytes};
use crate::models::{
    PromptKind, PromptOption, SessionEventBody, SessionStatus, OCCUPIED_SESSION_NOTICE,
};

use super::catalog::{build_turn_input, slash_help, split_command};
use super::process::{hide_console, truncate};
use super::resume::{bodies_from_turns, chronological_turns, HISTORY_PAGE_CAP, HISTORY_TURN_LIMIT};
use super::state::{emit, emit_status, Access, Pending, Shared};

impl Shared {
    pub(super) fn ensure_open(&self) -> Result<(), AgentError> {
        if self.closed.load(Ordering::SeqCst) {
            Err(AgentError::Closed)
        } else {
            Ok(())
        }
    }

    pub(super) fn note_access(&self) {
        let access = *self.access.lock().unwrap();
        emit(
            &self.events,
            SessionEventBody::System {
                text: format!(
                    "权限已设为{}（sandbox {} / approval {}）。下一条消息起生效。",
                    access.label(),
                    access.sandbox_mode(),
                    access.approval_policy(),
                ),
            },
        );
    }

    pub(super) async fn begin_turn(&self, text: String) -> Result<(), AgentError> {
        if self.read_only() {
            return Err(AgentError::Runtime(OCCUPIED_SESSION_NOTICE.into()));
        }
        if !self.pending.lock().unwrap().is_empty() {
            return Err(AgentError::PendingPrompt);
        }
        if self.turn_open.load(Ordering::SeqCst) {
            return Err(AgentError::Busy);
        }
        emit_status(&self.events, SessionStatus::Running);
        self.ensure_thread().await?;
        let thread_id = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Runtime("Codex 线程未建立".into()))?;
        let access = *self.access.lock().unwrap();
        if self.skills.lock().unwrap().is_empty() {
            if let Err(err) = self.refresh_skills().await {
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: format!("读取技能列表失败，本次按普通文本发送：{err}"),
                    },
                );
            }
        }
        let input = {
            let skills = self.skills.lock().unwrap();
            build_turn_input(&text, &skills)
        };
        if !self.titled.swap(true, Ordering::SeqCst) {
            let name = truncate(text.lines().next().unwrap_or("").trim(), 48);
            if !name.is_empty() {
                let _ = self
                    .request(
                        "thread/name/set",
                        json!({ "threadId": thread_id.clone(), "name": name }),
                    )
                    .await;
            }
        }
        let mut params = json!({
            "threadId": thread_id,
            "input": input,
            "approvalPolicy": access.approval_policy(),
            "sandboxPolicy": access.sandbox_policy(),
        });
        if let Some(model) = self.model_override.lock().unwrap().clone() {
            params["model"] = json!(model);
        }
        if let Some(effort) = self.effort.lock().unwrap().clone() {
            params["effort"] = json!(effort);
        }
        self.turn_open.store(true, Ordering::SeqCst);
        if !self.write_method("turn/start", params) {
            self.turn_open.store(false, Ordering::SeqCst);
            return Err(AgentError::Runtime("无法向 Codex CLI 写入消息".into()));
        }
        Ok(())
    }

    pub(super) async fn restore_thread(&self, thread_id: &str) {
        *self.thread_id.lock().unwrap() = Some(thread_id.to_string());
        self.load_history(thread_id).await;
        match self
            .request(
                "thread/resume",
                json!({
                    "threadId": thread_id,
                    "excludeTurns": true,
                }),
            )
            .await
        {
            Ok(result) => {
                if let Some(model) = result.get("model").and_then(Value::as_str) {
                    *self.model.lock().unwrap() = model.to_string();
                }
            }
            Err(err) => {
                let raw = err.to_string();
                // 写锁被占用时历史已经在上面载入。不要把这次打开记成失败。
                if !self.reject_writer_conflict(&raw) {
                    emit(
                        &self.events,
                        SessionEventBody::System {
                            text: format!("恢复 Codex 会话失败：{raw}"),
                        },
                    );
                }
            }
        }
    }

    pub(super) async fn load_history(&self, thread_id: &str) {
        let mut cursor: Option<String> = None;
        let mut pages = Vec::new();
        let mut older = false;
        for _ in 0..HISTORY_PAGE_CAP {
            let mut params = json!({
                "threadId": thread_id,
                "limit": HISTORY_TURN_LIMIT,
                "itemsView": "summary",
                "sortDirection": "desc",
            });
            if let Some(cursor) = &cursor {
                params["cursor"] = json!(cursor);
            }
            let Ok(page) = self.request("thread/turns/list", params).await else {
                break;
            };
            let data = page
                .get("data")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            pages.push(data);
            let next = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|cursor| !cursor.is_empty())
                .map(str::to_string);
            if next.is_none() {
                break;
            }
            if pages.len() == HISTORY_PAGE_CAP {
                older = true;
                break;
            }
            cursor = next;
        }
        if older {
            emit(
                &self.events,
                SessionEventBody::System {
                    text: "更早的 Codex 记录没有全部载入。".into(),
                },
            );
        }
        let turns = chronological_turns(&pages);
        for body in bodies_from_turns(&turns) {
            emit(&self.events, body);
        }
    }

    pub(super) async fn ensure_thread(&self) -> Result<(), AgentError> {
        if self.thread_id.lock().unwrap().is_some() {
            return Ok(());
        }
        let access = *self.access.lock().unwrap();
        let result = self
            .request(
                "thread/start",
                json!({
                    "cwd": self.cwd,
                    "approvalPolicy": access.approval_policy(),
                    "sandbox": access.sandbox_mode(),
                    "ephemeral": !self.persist,
                }),
            )
            .await?;
        let thread_id = result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if thread_id.is_empty() {
            return Err(AgentError::Runtime("Codex 没有返回线程 id".into()));
        }
        if let Some(model) = result
            .get("model")
            .and_then(Value::as_str)
            .or_else(|| result.pointer("/thread/model").and_then(Value::as_str))
        {
            *self.model.lock().unwrap() = model.to_string();
        }
        *self.thread_id.lock().unwrap() = Some(thread_id.clone());
        // `thread/start` 只在内存里建线程。Codex 要等线程名写入后才把 rollout
        // 落到 `~/.codex/sessions`，`codex resume <id>` 才能找到它。
        // 还没有任何回合时，`thread/list`（即 `codex resume` 选择器）不会列出它；
        // 第一条消息完成后再出现。
        if let Err(err) = self
            .request(
                "thread/name/set",
                json!({ "threadId": thread_id, "name": "未命名会话" }),
            )
            .await
        {
            emit(
                &self.events,
                SessionEventBody::System {
                    text: format!("Codex 线程已创建，但写入 resume 记录失败：{err}"),
                },
            );
        }
        Ok(())
    }

    pub(super) async fn handle_slash(&self, text: &str) -> Result<(), AgentError> {
        let (name, rest) = split_command(text);
        match name.as_str() {
            "help" => {
                emit(
                    &self.events,
                    SessionEventBody::System { text: slash_help() },
                );
            }
            "permissions" | "approvals" => {
                if rest.is_empty() {
                    self.ask_access();
                } else if let Some(access) = Access::parse(&rest) {
                    *self.access.lock().unwrap() = access;
                    self.note_access();
                } else {
                    return Err(AgentError::Runtime(
                        "用法：/permissions 完全访问 | 询问批准 | 只读".into(),
                    ));
                }
            }
            "status" => self.emit_status_card(),
            "diff" => self.emit_diff().await,
            "model" => {
                if rest.is_empty() {
                    let model = self.model.lock().unwrap().clone();
                    let shown = if model.is_empty() { "（线程尚未启动）" } else { &model };
                    emit(
                        &self.events,
                        SessionEventBody::System {
                            text: format!("当前模型：{shown}。用法：/model <模型 id>"),
                        },
                    );
                } else {
                    *self.model_override.lock().unwrap() = Some(rest.to_string());
                    emit(
                        &self.events,
                        SessionEventBody::System {
                            text: format!("下一条消息将使用模型 {rest}。"),
                        },
                    );
                }
            }
            "review" => {
                let prompt = if rest.is_empty() {
                    "Review the current working tree. Focus on behavior changes, bugs, and missing tests. Do not modify files.".into()
                } else {
                    format!("Review the current working tree. {rest}")
                };
                self.begin_turn(prompt).await?;
            }
            "plan" => {
                let prompt = if rest.is_empty() {
                    "Switch to plan mode. Propose an execution plan only. Do not edit files or run mutating commands.".into()
                } else {
                    format!("Plan only. Do not edit files or run mutating commands.\n\n{rest}")
                };
                self.begin_turn(prompt).await?;
            }
            "compact" => {
                self.ensure_thread().await?;
                let thread_id = self.thread_id.lock().unwrap().clone().unwrap_or_default();
                let _ = self.write_method("thread/compact/start", json!({ "threadId": thread_id }));
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: "已请求压缩当前 Codex 线程的上下文。".into(),
                    },
                );
            }
            "approve" => {
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: "重试自动审查拒绝需要 Codex 附带的审查事件。工作台没有保存到这样的事件，请在时间线上点「允许」或「拒绝」。".into(),
                    },
                );
            }
            "new" | "clear" => {
                *self.thread_id.lock().unwrap() = None;
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: "已放下当前 Codex 线程。下一条消息会开一个新线程。".into(),
                    },
                );
            }
            "quit" | "exit" | "stop" => self.stop(),
            "init" => {
                self.begin_turn(
                    "Create an AGENTS.md scaffold for this repository if one does not already exist. Keep it short and specific to the code you can see.".into(),
                )
                .await?;
            }
            _ => {
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: format!(
                            "/{name} 是 Codex 终端里的命令，工作台不会把它当成给模型的提示。输入 /help 查看这里能执行的命令。"
                        ),
                    },
                );
            }
        }
        Ok(())
    }

    pub(super) fn ask_access(&self) {
        let prompt_id = "local-access".to_string();
        self.pending
            .lock()
            .unwrap()
            .insert(prompt_id.clone(), Pending::Access);
        emit(
            &self.events,
            SessionEventBody::Prompt {
                prompt_id,
                prompt_kind: PromptKind::Choice,
                question: "选择 Codex 权限。完全访问对应 danger-full-access；询问批准对应 workspace-write + on-request；只读对应 read-only。".into(),
                options: vec![
                    PromptOption { id: "full".into(), label: "完全访问".into(), description: String::new() },
                    PromptOption { id: "ask".into(), label: "询问批准".into(), description: String::new() },
                    PromptOption { id: "read-only".into(), label: "只读".into(), description: String::new() },
                ],
                questions: Vec::new(),
            },
        );
        emit_status(&self.events, SessionStatus::NeedsInput);
    }

    pub(super) fn emit_status_card(&self) {
        let access = *self.access.lock().unwrap();
        let model = self.model.lock().unwrap().clone();
        let thread = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "（尚未开始）".into());
        let version = self.version.lock().unwrap().clone();
        emit(
            &self.events,
            SessionEventBody::System {
                text: format!(
                    "Codex {version}\n模型：{}\n线程：{thread}\n目录：{}\n权限：{}（sandbox {} / approval {}）",
                    if model.is_empty() { "（尚未开始）" } else { &model },
                    self.cwd,
                    access.label(),
                    access.sandbox_mode(),
                    access.approval_policy(),
                ),
            },
        );
    }

    pub(super) async fn emit_diff(&self) {
        let mut git = Command::new("git");
        git.arg("-c")
            .arg("core.quotepath=false")
            .arg("-C")
            .arg(&self.cwd)
            // 中文文件名按 UTF-8 原样输出，而不是八进制转义。
            .arg("-c")
            .arg("core.quotepath=false")
            .arg("diff")
            .arg("--stat")
            .arg("HEAD");
        apply_utf8_env(&mut git);
        hide_console(&mut git);
        apply_utf8_env(&mut git);
        let output = git.output().await;
        let text = match output {
            Ok(output) if output.status.success() => {
                let mut body = decode_child_bytes(&output.stdout).trim().to_string();
                if body.is_empty() {
                    body = "工作区相对 HEAD 没有差异。".into();
                }
                if body.chars().count() > 4000 {
                    body = body.chars().take(4000).collect();
                    body.push_str("\n…");
                }
                body
            }
            Ok(output) => {
                let err = decode_child_bytes(&output.stderr);
                format!("无法读取 git diff：{}", err.trim())
            }
            Err(err) => format!("无法运行 git：{err}"),
        };
        emit(&self.events, SessionEventBody::System { text });
    }

}
