//! `thread/status/changed` 与线程对象里的 `status`（v2 `ThreadStatus`）→ 会话状态。
//!
//! 运行状态只以 app-server 报的为准：
//! - `active` 带 `waitingOnApproval` / `waitingOnUserInput` → 等待输入
//! - `active` 其余 → 运行中
//! - `systemError` → 失败
//! - `idle` / `notLoaded` → 空闲（工作台没有单独的「未载入」状态，两者都表示没有回合在跑）
//!
//! 进程退出和用户停止不是线程状态，仍由会话进程本身报告。

use std::sync::atomic::Ordering;

use serde_json::Value;

use crate::models::SessionStatus;

use super::state::{emit_status, Shared};

pub(super) fn session_status(status: &Value) -> Option<SessionStatus> {
    match status.get("type").and_then(Value::as_str)? {
        "idle" | "notLoaded" => Some(SessionStatus::Completed),
        "systemError" => Some(SessionStatus::Failed),
        "active" => {
            let waiting = status
                .get("activeFlags")
                .and_then(Value::as_array)
                .is_some_and(|flags| {
                    flags.iter().any(|flag| {
                        matches!(
                            flag.as_str(),
                            Some("waitingOnApproval" | "waitingOnUserInput")
                        )
                    })
                });
            Some(if waiting {
                SessionStatus::NeedsInput
            } else {
                SessionStatus::Running
            })
        }
        _ => None,
    }
}

impl Shared {
    /// 只认本会话线程的通知。
    pub(super) fn on_thread_status(&self, params: &Value) {
        let ours = self.thread_id.lock().unwrap().clone();
        let thread = params.get("threadId").and_then(Value::as_str);
        if ours.is_none() || ours.as_deref() != thread {
            return;
        }
        if let Some(status) = params.get("status").and_then(session_status) {
            self.status_known.store(true, Ordering::SeqCst);
            emit_status(&self.events, status);
        }
    }

    /// `thread/start` / `thread/resume` 回包里的 `thread.status`。
    pub(super) fn apply_thread_snapshot(&self, result: &Value) {
        if let Some(sources) = result.get("instructionSources").and_then(Value::as_array) {
            *self.instruction_sources.lock().unwrap() = sources
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
        }
        if let Some(effort) = result.get("reasoningEffort").and_then(Value::as_str) {
            *self.thread_effort.lock().unwrap() = Some(effort.to_string());
        }
        if let Some(name) = result.pointer("/thread/name").and_then(Value::as_str) {
            *self.thread_name.lock().unwrap() = Some(name.to_string());
        }
        if let Some(status) = result.pointer("/thread/status").and_then(session_status) {
            self.status_known.store(true, Ordering::SeqCst);
            emit_status(&self.events, status);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_the_four_v2_thread_statuses() {
        assert_eq!(
            session_status(&json!({ "type": "idle" })),
            Some(SessionStatus::Completed)
        );
        assert_eq!(
            session_status(&json!({ "type": "notLoaded" })),
            Some(SessionStatus::Completed)
        );
        assert_eq!(
            session_status(&json!({ "type": "systemError" })),
            Some(SessionStatus::Failed)
        );
        assert_eq!(
            session_status(&json!({ "type": "active", "activeFlags": [] })),
            Some(SessionStatus::Running)
        );
        assert_eq!(
            session_status(&json!({ "type": "active", "activeFlags": ["waitingOnApproval"] })),
            Some(SessionStatus::NeedsInput)
        );
        assert_eq!(
            session_status(&json!({ "type": "active", "activeFlags": ["waitingOnUserInput"] })),
            Some(SessionStatus::NeedsInput)
        );
        assert_eq!(session_status(&json!({ "type": "somethingNew" })), None);
    }
}
