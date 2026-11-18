//! Claude 的后台任务（`local_bash` 等不是子 Agent 的任务）→ `BackgroundTask`。
//!
//! 实时流里一个任务依次是：`system/task_started`（`task_type`、`tool_use_id`、`description`、`is_backgrounded`）、
//! `task_updated`（`patch.status`、`patch.end_time`）、`task_notification`（`status`、`summary`、`output_file`）。
//! 主会话前台的 Bash 不发 `task_started`；子 Agent 自己的前台命令发，但 `is_backgrounded: false`（2.1.312 实录），
//! 所以只认 `is_backgrounded: true` 的。`stop_task` 停掉后，`task_updated` 报 `killed`，`task_notification` 报 `stopped`。
//! 实测 Claude Code 2.1.326（2026-11-17）。
//!
//! 子 Agent 放到后台的命令（`owned_by_subagent: true`）不登记：子 Agent 一结束 CLI 就把它杀掉（2.1.326，2026-11-18 实录
//! `task_updated: killed`），活不过子 Agent，子 Agent 在跑时它的卡片已让会话算在做；它的工具卡片也不在主时间线上。
//!
//! 转录里只有任务结束时那条 task-notification 用户消息。读历史时不建任务：那时进程早就不在了，任务也不会再跑。

use serde_json::Value;

use aiwb_core::models::{BackgroundTask, BackgroundTaskStatus, SessionEventBody, SubagentStatus};

use super::messages::MapState;
use super::subagents;
use crate::protocol::text;

/// 子 Agent 的任务种类，归 `subagents` 管。
const AGENT_TASK: &str = "local_agent";

impl MapState {
    /// 进程退出时还在跑的后台任务记成已停止。
    pub(super) fn stop_background(&mut self) -> Vec<SessionEventBody> {
        BackgroundTask::stop_all(self.background.values_mut())
    }

    /// 还在跑的后台任务。停止时用来确认。
    pub(super) fn background_running(&self, task_id: &str) -> bool {
        self.background.get(task_id).is_some_and(BackgroundTask::running)
    }
}

/// `system/task_*`。是后台任务时返回要发的事件，子 Agent 的任务和不认识的任务返回 None。
pub(super) fn on_task(state: &mut MapState, subtype: &str, value: &Value, live: bool) -> Option<Vec<SessionEventBody>> {
    let task_id = text(value, "task_id")?;
    if subtype == "task_started" {
        let kind = text(value, "task_type").filter(|kind| kind != AGENT_TASK)?;
        let flag = |key: &str| value.get(key).and_then(Value::as_bool) == Some(true);
        if !live || !flag("is_backgrounded") || flag("owned_by_subagent") {
            return None;
        }
        let mut task = BackgroundTask::new(&task_id, kind, text(value, "description").unwrap_or_default());
        task.tool_call_id = text(value, "tool_use_id");
        task.started_at = state.clock;
        state.background.insert(task_id, task.clone());
        return Some(vec![SessionEventBody::BackgroundTask(task)]);
    }
    let at = state.clock;
    let task = state.background.get_mut(&task_id)?;
    match subtype {
        "task_updated" => {
            let patch = value.get("patch").unwrap_or(&Value::Null);
            let status = patch.get("status").and_then(Value::as_str).and_then(status_of)?;
            task.finish(status, patch.get("end_time").and_then(Value::as_i64).or(at));
        }
        "task_notification" => {
            if let Some(summary) = text(value, "summary") {
                task.result = summary;
            }
            if let Some(file) = text(value, "output_file") {
                task.output_file = Some(file);
            }
            let status = value.get("status").and_then(Value::as_str).and_then(status_of);
            // 结束状态已由 `task_updated` 定下时，`finish` 不再改它，只补摘要和输出文件。
            task.finish(status.unwrap_or(BackgroundTaskStatus::Completed), at);
        }
        _ => return Some(Vec::new()),
    }
    Some(vec![SessionEventBody::BackgroundTask(task.clone())])
}

/// 结束状态，和子 Agent 认同一套原生状态词。还在跑或认不出的返回 None。
fn status_of(status: &str) -> Option<BackgroundTaskStatus> {
    match subagents::status_of(status) {
        SubagentStatus::Running => None,
        SubagentStatus::Completed => Some(BackgroundTaskStatus::Completed),
        SubagentStatus::Failed => Some(BackgroundTaskStatus::Failed),
        SubagentStatus::Stopped => Some(BackgroundTaskStatus::Stopped),
    }
}
