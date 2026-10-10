//! 回合、线程恢复、斜杠命令执行。

use std::sync::atomic::Ordering;

use serde_json::{json, Value};
use tokio::process::Command;

use crate::features::agents::AgentError;
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
        self.begin_user_turn(text, Vec::new(), String::new()).await
    }

    pub(super) async fn begin_user_turn(
        &self,
        text: String,
        images: Vec<String>,
        client_id: String,
    ) -> Result<(), AgentError> {
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
            build_turn_input(&text, &skills, &images)
        };
        if !self.titled.swap(true, Ordering::SeqCst) {
            let label = if text.trim().is_empty() {
                "图片"
            } else {
                text.as_str()
            };
            let name = truncate(label.lines().next().unwrap_or("").trim(), 48);
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
        if !client_id.is_empty() {
            params["clientUserMessageId"] = json!(client_id);
        }
        if let Some(model) = self.model_override.lock().unwrap().clone() {
            params["model"] = json!(model);
        }
        if let Some(effort) = self.effort.lock().unwrap().clone() {
            params["effort"] = json!(effort);
        }
        if let Err(err) = self.attach_plan_mode(&mut params) {
            emit_status(&self.events, SessionStatus::Failed);
            return Err(err);
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
        self.refresh_queue().await;
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
        self.refresh_queue().await;
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
            "review" => match super::gap::parse_review_slash(&rest)? {
                None => emit(
                    &self.events,
                    SessionEventBody::System {
                        text: super::gap::REVIEW_DESCRIPTION.into(),
                    },
                ),
                Some(target) => self.start_review(&target).await?,
            },
            "plan" => {
                if rest.is_empty() {
                    let next = if self.collaboration_is_plan() {
                        "default"
                    } else {
                        "plan"
                    };
                    self.set_collaboration_mode(next)?;
                } else {
                    self.set_collaboration_mode("plan")?;
                    self.begin_turn(rest).await?;
                }
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
            "mcp" => self.emit_mcp(rest.trim()).await?,
            "goal" => self.emit_goal(&rest).await?,
            "hooks" => self.emit_hooks().await?,
            "worktree" => self.emit_worktree(&rest).await?,
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

    pub(super) async fn emit_mcp(&self, rest: &str) -> Result<(), AgentError> {
        let verbose = rest.eq_ignore_ascii_case("verbose");
        if !rest.is_empty() && !verbose {
            return Err(AgentError::Runtime("用法：/mcp 或 /mcp verbose".into()));
        }
        let mut params = json!({ "limit": 100, "detail": "toolsAndAuthOnly" });
        if let Some(thread_id) = self.thread_id.lock().unwrap().clone() {
            params["threadId"] = json!(thread_id);
        }
        let status = self.request("mcpServerStatus/list", params).await?;
        let config = self.request("config/read", json!({})).await?;
        let servers = super::host::merge_mcp_servers(&config, &[status]);
        emit(
            &self.events,
            SessionEventBody::System {
                text: super::host::render_mcp(&servers, verbose),
            },
        );
        Ok(())
    }

    pub(super) async fn emit_goal(&self, rest: &str) -> Result<(), AgentError> {
        self.ensure_thread().await?;
        let thread_id = self.thread_id.lock().unwrap().clone().unwrap_or_default();
        let action = goal_action(rest)?;
        let text = match action {
            GoalAction::View => {
                let value = self
                    .request("thread/goal/get", json!({ "threadId": thread_id }))
                    .await?;
                render_goal(value.get("goal"))
            }
            GoalAction::Clear => {
                self.request(
                    "thread/goal/clear",
                    json!({ "threadId": thread_id, "origin": "user" }),
                )
                .await?;
                "已清除任务目标。".into()
            }
            GoalAction::Set { objective, status } => {
                let objective = if objective.is_empty() {
                    let current = self
                        .request("thread/goal/get", json!({ "threadId": thread_id }))
                        .await?;
                    current
                        .pointer("/goal/objective")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_string()
                } else {
                    objective
                };
                if objective.is_empty() {
                    return Err(AgentError::Runtime(
                        "当前没有任务目标。用法：/goal <目标>".into(),
                    ));
                }
                self.request(
                    "thread/goal/set",
                    json!({
                        "threadId": thread_id,
                        "objective": objective,
                        "status": status,
                        "origin": "user",
                    }),
                )
                .await?;
                format!("任务目标：{objective}（{}）", goal_status_label(status))
            }
        };
        emit(&self.events, SessionEventBody::System { text });
        Ok(())
    }

    pub(super) async fn emit_hooks(&self) -> Result<(), AgentError> {
        let value = self
            .request("hooks/list", json!({ "cwds": [self.cwd] }))
            .await?;
        let hooks = super::host::parse_hooks(&value);
        emit(
            &self.events,
            SessionEventBody::System {
                text: super::host::render_hooks(&hooks),
            },
        );
        Ok(())
    }

    pub(super) async fn emit_worktree(&self, rest: &str) -> Result<(), AgentError> {
        let text = match rest.trim() {
            "" | "status" => super::worktree::render_worktrees(&self.cwd).await?,
            "new" | "create" => {
                let created = super::worktree::create_worktree(&self.cwd).await?;
                format!(
                    "已新建工作树（detached HEAD）：\n{}\n桌面端会在新对话里选择 Worktree；这里的目录可以单独打开。",
                    created.path
                )
            }
            _ => "用法：/worktree 查看，/worktree new 在工作树根目录新建一个 detached HEAD。".into(),
        };
        emit(&self.events, SessionEventBody::System { text });
        Ok(())
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

#[derive(Debug)]
enum GoalAction {
    View,
    Clear,
    Set { objective: String, status: &'static str },
}

fn goal_action(rest: &str) -> Result<GoalAction, AgentError> {
    let rest = rest.trim();
    if rest.is_empty() {
        return Ok(GoalAction::View);
    }
    let (verb, tail) = split_command(&format!("/{rest}"));
    match verb.as_str() {
        "clear" => Ok(GoalAction::Clear),
        "pause" if tail.trim().is_empty() => Ok(GoalAction::Set {
            objective: String::new(),
            status: "paused",
        }),
        "pause" => goal_set(&tail, "paused", "用法：/goal pause 或 /goal pause <目标>"),
        "resume" if tail.trim().is_empty() => Ok(GoalAction::Set {
            objective: String::new(),
            status: "active",
        }),
        "resume" => goal_set(&tail, "active", "用法：/goal resume 或 /goal resume <目标>"),
        "edit" => {
            if tail.trim().is_empty() {
                Err(AgentError::Runtime(
                    "用法：/goal edit <新目标>。目标不能为空，最多 4000 个字符。".into(),
                ))
            } else {
                goal_set(&tail, "active", "用法：/goal edit <新目标>")
            }
        }
        _ => goal_set(rest, "active", "用法：/goal <目标>"),
    }
}

fn goal_set(objective: &str, status: &'static str, usage: &str) -> Result<GoalAction, AgentError> {
    let objective = objective.trim();
    if objective.is_empty() && status != "active" && status != "paused" {
        return Err(AgentError::Runtime(usage.into()));
    }
    if objective.is_empty() {
        return Err(AgentError::Runtime(
            "先用 /goal <目标> 设置目标，再暂停或继续。目标不能为空，最多 4000 个字符。".into(),
        ));
    }
    if objective.chars().count() > 4000 {
        return Err(AgentError::Runtime(
            "目标最长 4000 个字符。更长的说明写进文件，让目标指向那个文件。".into(),
        ));
    }
    Ok(GoalAction::Set {
        objective: objective.to_string(),
        status,
    })
}

fn render_goal(goal: Option<&Value>) -> String {
    let Some(goal) = goal.filter(|value| !value.is_null()) else {
        return "当前没有任务目标。用法：/goal <目标>，/goal edit <新目标>，/goal pause，/goal resume，/goal clear。".into();
    };
    let objective = goal.get("objective").and_then(Value::as_str).unwrap_or("");
    let status = goal.get("status").and_then(Value::as_str).unwrap_or("active");
    format!(
        "任务目标（{}）：{objective}",
        goal_status_label(status)
    )
}

fn goal_status_label(status: &str) -> &'static str {
    match status {
        "active" => "进行中",
        "paused" => "已暂停",
        "blocked" => "受阻",
        "usageLimited" => "用量已满",
        "budgetLimited" => "预算已满",
        "complete" => "已完成",
        _ => "进行中",
    }
}

#[cfg(test)]
mod goal_tests {
    use super::*;

    #[test]
    fn goal_commands_match_desktop_slash() {
        assert!(matches!(goal_action("").unwrap(), GoalAction::View));
        assert!(matches!(goal_action("clear").unwrap(), GoalAction::Clear));
        assert!(matches!(goal_action("edit").unwrap_err(), AgentError::Runtime(_)));
        match goal_action("edit 把测试补上").unwrap() {
            GoalAction::Set { objective, status } => {
                assert_eq!(objective, "把测试补上");
                assert_eq!(status, "active");
            }
            _ => panic!("edit sets the objective"),
        }
        match goal_action("pause 先停一下").unwrap() {
            GoalAction::Set { status, .. } => assert_eq!(status, "paused"),
            _ => panic!("pause"),
        }
        assert!(goal_action(&"字".repeat(4001)).is_err());
    }
}
