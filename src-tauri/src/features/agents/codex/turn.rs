//! 回合、线程恢复、斜杠命令执行。

use std::sync::atomic::Ordering;

use serde_json::{json, Value};

use crate::features::agents::AgentError;
use crate::models::{
    PageAnnotation, PromptKind, PromptOption, ReviewStart, SessionEventBody,
    OCCUPIED_SESSION_NOTICE,
};

use super::catalog::{build_turn_input, slash_help, split_command};
use super::history::{bodies_from_turns, chronological_turns, HISTORY_TURN_LIMIT};
use super::process::truncate;
use super::sandbox::merge_json;
use super::state::{emit, Pending, Shared};

/// `/init` 的提示原文，逐字取自 openai/codex rust-v0.162.1
/// `codex-rs/tui/assets/prompt_for_init_command.md`（tag 提交 092d3acd，文件 sha256 70dfe903…）。
/// 提示本身要求 AGENTS.md 已存在时不覆盖、不修改。
///
/// 工作区如果被检出成 CRLF，`include_bytes!` 会带上 `\r`。发出去之前去掉，
/// 让字节和官方 LF 资产一致。`.gitattributes` 里这条资产也固定 `eol=lf`。
const RAW_INIT_PROMPT: &[u8] = include_bytes!("assets/prompt_for_init_command.md");

const fn count_without_cr(input: &[u8]) -> usize {
    let mut count = 0;
    let mut index = 0;
    while index < input.len() {
        if input[index] != b'\r' {
            count += 1;
        }
        index += 1;
    }
    count
}

const INIT_PROMPT_LEN: usize = count_without_cr(RAW_INIT_PROMPT);

const fn strip_cr<const N: usize>(input: &[u8]) -> [u8; N] {
    let mut out = [0u8; N];
    let mut index = 0;
    let mut written = 0;
    while index < input.len() {
        if input[index] != b'\r' {
            out[written] = input[index];
            written += 1;
        }
        index += 1;
    }
    out
}

const INIT_PROMPT_BYTES: [u8; INIT_PROMPT_LEN] = strip_cr(RAW_INIT_PROMPT);

pub(super) const INIT_PROMPT: &str = match std::str::from_utf8(&INIT_PROMPT_BYTES) {
    Ok(text) => text,
    Err(_) => panic!("init prompt is not utf-8"),
};
#[cfg(test)]
pub(super) const INIT_PROMPT_SOURCE: &str =
    "openai/codex rust-v0.162.1 codex-rs/tui/assets/prompt_for_init_command.md";

const WORKTREE_NOT_WIRED: &str = "/worktree 在 Codex TUI 里是托管工作树（codex_worktree + thread/attachment/add）。工作台还没有接入这套接口，这里不创建工作树。";

struct HistoryPage {
    data: Vec<Value>,
    next: Option<String>,
}

impl Shared {
    pub(super) fn ensure_open(&self) -> Result<(), AgentError> {
        if self.closed.load(Ordering::SeqCst) {
            Err(AgentError::Closed)
        } else {
            Ok(())
        }
    }

    pub(super) fn note_access(&self) {
        let access = self.access.lock().unwrap().clone();
        emit(
            &self.events,
            SessionEventBody::System {
                text: access.summary(),
            },
        );
    }

    /// 先在时间线写用户气泡，再发出回合。斜杠命令触发的提示走这里，和用户亲手输入一样显示。
    pub(super) async fn submit_user_text(&self, text: String) -> Result<(), AgentError> {
        emit(
            &self.events,
            SessionEventBody::UserMessage {
                text: text.clone(),
                images: Vec::new(),
                annotations: 0,
            },
        );
        self.begin_turn(text).await
    }

    pub(super) async fn begin_turn(&self, text: String) -> Result<(), AgentError> {
        self.begin_user_turn(text, Vec::new(), String::new(), Vec::new())
            .await
    }

    pub(super) async fn begin_user_turn(
        &self,
        text: String,
        images: Vec<String>,
        client_id: String,
        annotations: Vec<PageAnnotation>,
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
        self.ensure_wire().await;
        super::sandbox::require_supported(
            &self.access.lock().unwrap().clone(),
            *self.wire.lock().unwrap(),
            true,
        )?;
        self.ensure_thread().await?;
        let thread_id = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Runtime("Codex 线程未建立".into()))?;
        let access = self.access.lock().unwrap().clone();
        let wire = *self.wire.lock().unwrap();
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
            build_turn_input(&text, &skills, &images, &annotations)
        };
        if !self.titled.swap(true, Ordering::SeqCst) {
            let label = if text.trim().is_empty() {
                "图片"
            } else {
                text.as_str()
            };
            let name = truncate(label.lines().next().unwrap_or("").trim(), 48);
            if !name.is_empty() {
                *self.thread_name.lock().unwrap() = Some(name.clone());
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
            // 原生 TUI 每个用户回合都带 turnTrigger: "user"（tui/src/app_server_session.rs:1441），
            // Codex 把它写进回合元数据的 turn_trigger。
            "turnTrigger": "user",
        });
        merge_json(&mut params, access.turn_permissions(wire));
        if !client_id.is_empty() {
            params["clientUserMessageId"] = json!(client_id);
        }
        if let Some(model) = self.model_override.lock().unwrap().clone() {
            params["model"] = json!(model);
        }
        if let Some(effort) = self.effort.lock().unwrap().clone() {
            params["effort"] = json!(effort);
        }
        if let Some(tier) = self.service_tier.lock().unwrap().clone() {
            params["serviceTier"] = if tier.is_empty() {
                Value::Null
            } else {
                json!(tier)
            };
        }
        self.attach_plan_mode(&mut params)?;
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
                self.apply_thread_snapshot(&result);
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
        self.publish_rollout_usage(thread_id);
    }

    /// rollout 是打开时的累计。实时 `thread/tokenUsage/updated` 如果已经到了，就以它为准。
    fn publish_rollout_usage(&self, thread_id: &str) {
        let Some(info) = super::usage::latest_rollout_info(thread_id) else {
            return;
        };
        let mut slot = self.token_info.lock().unwrap();
        if slot.is_some() {
            return;
        }
        let body = super::usage::snapshot_from_info(&info);
        *slot = Some(info);
        emit(&self.events, body);
    }

    pub(super) async fn load_history(&self, thread_id: &str) {
        *self.history_cursor.lock().unwrap() = None;
        match self.fetch_history_page(thread_id, None).await {
            Ok(page) => {
                *self.history_cursor.lock().unwrap() = page.next;
                let turns = chronological_turns(std::slice::from_ref(&page.data));
                for body in bodies_from_turns(&turns) {
                    self.note_replayed(&body);
                    emit(&self.events, body);
                }
            }
            Err(err) => {
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: format!("读取 Codex 历史失败：{err}"),
                    },
                );
            }
        }
        self.refresh_queue().await;
    }

    /// 上滚再取一页更早的回合。游标空表示已经到头。
    pub(super) async fn load_older_history(
        &self,
    ) -> Result<(Vec<SessionEventBody>, bool), AgentError> {
        self.ensure_open()?;
        let thread_id = self.thread_id.lock().unwrap().clone().unwrap_or_default();
        if thread_id.is_empty() {
            return Ok((Vec::new(), true));
        }
        let cursor = self.history_cursor.lock().unwrap().clone();
        let Some(cursor) = cursor else {
            return Ok((Vec::new(), true));
        };
        let page = self.fetch_history_page(&thread_id, Some(cursor)).await?;
        let exhausted = page.next.is_none();
        *self.history_cursor.lock().unwrap() = page.next;
        let turns = chronological_turns(std::slice::from_ref(&page.data));
        let bodies = bodies_from_turns(&turns);
        for body in &bodies {
            self.note_replayed(body);
        }
        Ok((bodies, exhausted))
    }

    pub(super) fn note_replayed(&self, body: &SessionEventBody) {
        match body {
            SessionEventBody::TurnDiff { turn_id, diff } => {
                self.remember_turn_diff(turn_id, diff);
            }
            SessionEventBody::TurnChanges { turn_id, files } => {
                self.turn_files
                    .lock()
                    .unwrap()
                    .insert(turn_id.clone(), files.clone());
            }
            _ => {}
        }
    }

    pub(super) fn remember_turn_diff(&self, turn_id: &str, diff: &str) {
        if turn_id.is_empty() || diff.is_empty() {
            return;
        }
        self.turn_diffs
            .lock()
            .unwrap()
            .insert(turn_id.to_string(), diff.to_string());
        *self.last_turn_id.lock().unwrap() = Some(turn_id.to_string());
    }

    pub(super) fn remember_file_changes(
        &self,
        turn_id: &str,
        updated: &[crate::models::FileChange],
    ) -> Vec<crate::models::FileChange> {
        let mut map = self.turn_files.lock().unwrap();
        let slot = map.entry(turn_id.to_string()).or_default();
        let merged = crate::features::agents::changes::merge_file_list(slot, updated);
        *slot = merged;
        slot.clone()
    }

    async fn fetch_history_page(
        &self,
        thread_id: &str,
        cursor: Option<String>,
    ) -> Result<HistoryPage, AgentError> {
        let mut params = json!({
            "threadId": thread_id,
            "limit": HISTORY_TURN_LIMIT,
            "itemsView": "full",
            "sortDirection": "desc",
        });
        if let Some(cursor) = cursor {
            params["cursor"] = json!(cursor);
        }
        let page = self.request("thread/turns/list", params).await?;
        let data = page
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let next = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|cursor| !cursor.is_empty())
            .map(str::to_string);
        Ok(HistoryPage { data, next })
    }

    pub(super) async fn ensure_thread(&self) -> Result<(), AgentError> {
        if self.thread_id.lock().unwrap().is_some() {
            return Ok(());
        }
        self.ensure_wire().await;
        let access = self.access.lock().unwrap().clone();
        let wire = *self.wire.lock().unwrap();
        let mut params = json!({
            "cwd": self.cwd,
            "ephemeral": !self.persist,
            // 与原生 TUI、resume.rs 的 fork 一致；Codex 据此在回合元数据里写 thread_source=user。
            "threadSource": "user",
        });
        merge_json(&mut params, access.thread_permissions(wire));
        let result = self.request("thread/start", params).await?;
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
        self.apply_thread_snapshot(&result);
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
                    self.ask_access().await;
                } else {
                    let mut access = self.access.lock().unwrap();
                    if !access.apply_preset(&rest) {
                        return Err(AgentError::Runtime(
                            "用法：/permissions 完全访问 | 询问批准 | 替我批准 | 只读".into(),
                        ));
                    }
                    drop(access);
                    self.note_access();
                }
            }
            "status" => self.emit_status_card().await,
            "diff" => self.emit_diff().await,
            "model" => {
                if rest.is_empty() {
                    let model = self.model.lock().unwrap().clone();
                    let shown = if model.is_empty() {
                        "（线程尚未启动）"
                    } else {
                        &model
                    };
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
            // TUI：`/review <说明>` 直接按自定义说明审查；空参数由作曲栏打开审查菜单。
            "review" if !rest.trim().is_empty() => {
                self.start_review(&ReviewStart::Custom {
                    instructions: rest.clone(),
                })
                .await?
            }
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
                    self.submit_user_text(rest).await?;
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
            "approve" => self.open_denials(),
            // TUI：`/new [name]` 在没有托管工作树时直接 `NewSession { name }`；
            // `/clear [name]` 是 `ClearUi { name }`，同样开一个新会话。工作台交给宿主新建会话。
            "new" | "clear" => {
                let name = (!rest.trim().is_empty()).then(|| rest.trim().to_string());
                emit(
                    &self.events,
                    SessionEventBody::NewThread { name, text: None },
                );
            }
            "quit" | "exit" => self.stop(),
            // TUI `/stop`：`thread/backgroundTerminals/clean`，不结束会话。
            "stop" => {
                let thread_id = self.thread_id.lock().unwrap().clone();
                if let Some(thread_id) = thread_id {
                    self.request(
                        "thread/backgroundTerminals/clean",
                        json!({ "threadId": thread_id }),
                    )
                    .await?;
                }
                emit(
                    &self.events,
                    SessionEventBody::System {
                        text: "Stopping all background terminals.".into(),
                    },
                );
            }
            "mcp" => self.emit_mcp(rest.trim()).await?,
            "goal" => self.emit_goal(&rest).await?,
            "hooks" => self.emit_hooks().await?,
            "worktree" => emit(
                &self.events,
                SessionEventBody::System {
                    text: WORKTREE_NOT_WIRED.into(),
                },
            ),
            // `slash_dispatch.rs`：把官方 init 提示原文当作普通用户消息发出。
            "init" => self.submit_user_text(INIT_PROMPT.to_string()).await?,
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

    /// `/permissions`：与作曲栏同一份菜单（`permissionProfile/list`）。
    pub(super) async fn ask_access(&self) {
        let menu = match self.refresh_sandbox_features().await {
            Ok(menu) => menu,
            Err(err) => {
                emit(
                    &self.events,
                    SessionEventBody::Error {
                        message: err.to_string(),
                    },
                );
                return;
            }
        };
        let mut options: Vec<PromptOption> = menu
            .presets
            .iter()
            .chain(menu.profiles.iter())
            .filter(|item| item.disabled_reason.is_none())
            .map(|item| PromptOption {
                id: item.id.clone(),
                label: item.label.clone(),
                description: item.description.clone(),
                ..Default::default()
            })
            .collect();
        if options.is_empty() {
            let text = menu.notice.unwrap_or_else(|| menu.title.clone());
            emit(&self.events, SessionEventBody::System { text });
            return;
        }
        options.dedup_by(|a, b| a.id == b.id);
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
                question: menu.title,
                options,
                questions: Vec::new(),
            },
        );
    }

    /// `/status`（`status/card.rs`）。账户和额度每次现读。
    pub(super) async fn emit_status_card(&self) {
        let account = self
            .request("account/read", json!({ "refreshToken": false }))
            .await
            .ok()
            .and_then(|value| value.get("account").cloned())
            .filter(|value| !value.is_null());
        let rate_limits = if account.is_some() {
            self.request("account/rateLimits/read", Value::Null)
                .await
                .ok()
        } else {
            None
        };
        let access = self.access.lock().unwrap().clone();
        let model = self.model.lock().unwrap().clone();
        let effort = self.effective_effort();
        let input = super::status::StatusInput {
            version: self.version.lock().unwrap().clone(),
            model: if model.is_empty() {
                self.model_override
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_default()
            } else {
                model
            },
            reasoning_effort: effort,
            directory: super::status::directory_display(&self.cwd),
            permissions: access.status_label(),
            agents_summary: super::status::agents_summary(
                &self.cwd,
                &self.instruction_sources.lock().unwrap(),
            ),
            account,
            thread_name: self.thread_name.lock().unwrap().clone(),
            collaboration_mode: Some(if self.collaboration_is_plan() {
                "Plan"
            } else {
                "Default"
            }),
            session_id: self.thread_id.lock().unwrap().clone(),
            token_info: *self.token_info.lock().unwrap(),
            rate_limits,
            now: chrono::Local::now(),
        };
        emit(
            &self.events,
            SessionEventBody::System {
                text: super::status::render(&input),
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
                emit(&self.events, goal_snapshot_event(value.get("goal")));
                render_goal(value.get("goal"))
            }
            GoalAction::Clear => {
                self.request(
                    "thread/goal/clear",
                    json!({ "threadId": thread_id, "origin": "user" }),
                )
                .await?;
                emit(&self.events, goal_snapshot_event(None));
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
                self.write_goal(&thread_id, &objective, status).await?;
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

    pub(super) async fn emit_diff(&self) {
        let text = super::git_diff::diff_text(std::path::Path::new(&self.cwd)).await;
        emit(&self.events, SessionEventBody::System { text });
    }

    /// 作曲栏目标芯片提交的原文。不走 `/goal` 的 clear/pause 解析，避免目标正文被当成子命令。
    pub(super) async fn set_goal_objective(&self, objective: &str) -> Result<(), AgentError> {
        let objective = objective.trim();
        if objective.is_empty() {
            return Err(AgentError::Runtime("目标不能为空。".into()));
        }
        if objective.chars().count() > 4000 {
            return Err(AgentError::Runtime(
                "目标最长 4000 个字符。更长的说明写进文件，让目标指向那个文件。".into(),
            ));
        }
        self.ensure_thread().await?;
        let thread_id = self.thread_id.lock().unwrap().clone().unwrap_or_default();
        self.write_goal(&thread_id, objective, "active").await?;
        emit(
            &self.events,
            SessionEventBody::System {
                text: format!("任务目标：{objective}（{}）", goal_status_label("active")),
            },
        );
        Ok(())
    }

    async fn write_goal(
        &self,
        thread_id: &str,
        objective: &str,
        status: &str,
    ) -> Result<(), AgentError> {
        let recorded = self
            .request(
                "thread/goal/set",
                json!({
                    "threadId": thread_id,
                    "objective": objective,
                    "status": status,
                    "origin": "user",
                }),
            )
            .await?;
        let fallback = json!({ "objective": objective, "status": status });
        let goal = match recorded.get("goal") {
            Some(value) if value.is_object() => value,
            _ => &fallback,
        };
        emit(&self.events, goal_snapshot_event(Some(goal)));
        Ok(())
    }

    /// 读当前线程目标并写成事件。还没有线程时不算失败，也不编造「没有目标」。
    pub(super) async fn publish_goal(&self) -> Result<(), AgentError> {
        let thread_id = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .filter(|id| !id.is_empty());
        let Some(thread_id) = thread_id else {
            return Ok(());
        };
        let value = self
            .request("thread/goal/get", json!({ "threadId": thread_id }))
            .await?;
        emit(&self.events, goal_snapshot_event(value.get("goal")));
        Ok(())
    }
}

/// `thread/goal/get`、`thread/goal/set` 和 `thread/goal/updated` 共用这一份快照。
pub(super) fn goal_snapshot_event(goal: Option<&Value>) -> SessionEventBody {
    let goal = goal.filter(|value| value.is_object());
    let objective = goal
        .and_then(|value| value.get("objective"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string);
    let status = goal
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string);
    let usage = goal.map(goal_usage);
    SessionEventBody::Goal {
        objective: objective.clone(),
        status: objective.and(status.map(|value| normalize_goal_status(&value))),
        token_budget: usage.and_then(|item| item.0),
        tokens_used: usage.and_then(|item| item.1),
        time_used_seconds: usage.and_then(|item| item.2),
    }
}

fn normalize_goal_status(status: &str) -> String {
    match status {
        "usage_limited" => "usageLimited".to_string(),
        "budget_limited" => "budgetLimited".to_string(),
        other => other.to_string(),
    }
}

/// 协议字段是 camelCase（`tokenBudget`）。兼容 snake_case。0 是有效用量，不能丢掉。
fn goal_usage(goal: &Value) -> (Option<i64>, Option<i64>, Option<i64>) {
    (
        goal_number(goal, &["tokenBudget", "token_budget"]),
        goal_number(goal, &["tokensUsed", "tokens_used"]),
        goal_number(goal, &["timeUsedSeconds", "time_used_seconds"]),
    )
}

fn goal_number(goal: &Value, keys: &[&str]) -> Option<i64> {
    for key in keys {
        let Some(value) = goal.get(*key) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        if let Some(number) = value.as_i64() {
            return Some(number);
        }
        if let Some(number) = value.as_u64() {
            return i64::try_from(number).ok();
        }
        if let Some(number) = value.as_f64() {
            if number.is_finite() {
                return Some(number as i64);
            }
        }
    }
    None
}

#[derive(Debug)]
enum GoalAction {
    View,
    Clear,
    Set {
        objective: String,
        status: &'static str,
    },
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
    let status = goal
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("active");
    format!("任务目标（{}）：{objective}", goal_status_label(status))
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
    fn init_prompt_is_the_official_asset() {
        assert!(INIT_PROMPT.starts_with(
            "Generate a file named AGENTS.md that serves as a contributor guide for this repository.\n"
        ));
        assert!(INIT_PROMPT.contains(
            "Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it."
        ));
        assert_eq!(INIT_PROMPT.len(), 1836);
        assert!(!INIT_PROMPT.contains('\r'));
        assert!(INIT_PROMPT_SOURCE.contains("rust-v0.162.1"));
        const CRLF: &[u8] = b"Generate a file named AGENTS.md that serves as a contributor guide for this repository.\r\nBefore";
        let normalized = strip_cr::<{ CRLF.len() - 1 }>(CRLF);
        assert_eq!(
            std::str::from_utf8(&normalized).unwrap(),
            "Generate a file named AGENTS.md that serves as a contributor guide for this repository.\nBefore"
        );
    }

    #[test]
    fn goal_commands_match_desktop_slash() {
        assert!(matches!(goal_action("").unwrap(), GoalAction::View));
        assert!(matches!(goal_action("clear").unwrap(), GoalAction::Clear));
        assert!(matches!(
            goal_action("edit").unwrap_err(),
            AgentError::Runtime(_)
        ));
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

    #[test]
    fn goal_snapshot_keeps_the_objective_and_clears_when_missing() {
        let event = goal_snapshot_event(Some(&json!({
            "objective": " 把测试补上 ",
            "status": "active",
        })));
        match event {
            SessionEventBody::Goal {
                objective, status, ..
            } => {
                assert_eq!(objective.as_deref(), Some("把测试补上"));
                assert_eq!(status.as_deref(), Some("active"));
            }
            _ => panic!("goal event"),
        }
        match goal_snapshot_event(Some(&Value::Null)) {
            SessionEventBody::Goal {
                objective,
                status,
                token_budget,
                tokens_used,
                time_used_seconds,
            } => {
                assert!(objective.is_none());
                assert!(status.is_none());
                assert!(token_budget.is_none());
                assert!(tokens_used.is_none());
                assert!(time_used_seconds.is_none());
            }
            _ => panic!("cleared goal"),
        }
    }

    #[test]
    fn goal_snapshot_keeps_usage_from_either_key_style() {
        match goal_snapshot_event(Some(&json!({
            "objective": "把测试补上",
            "status": "budget_limited",
            "tokenBudget": 50000,
            "tokens_used": 63876,
            "timeUsedSeconds": 120,
        }))) {
            SessionEventBody::Goal {
                status,
                token_budget,
                tokens_used,
                time_used_seconds,
                ..
            } => {
                assert_eq!(status.as_deref(), Some("budgetLimited"));
                assert_eq!(token_budget, Some(50000));
                assert_eq!(tokens_used, Some(63876));
                assert_eq!(time_used_seconds, Some(120));
            }
            _ => panic!("goal usage"),
        }
    }
}
