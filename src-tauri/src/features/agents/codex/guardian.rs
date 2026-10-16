//! 自动审查（auto-review / Guardian）拒绝与 `/approve`。
//!
//! 对齐 Codex TUI rust-v0.162.1：
//! - `item/autoApprovalReview/completed` 里 status 为 denied 的记进最近拒绝列表
//!   （`auto_review_denials.rs`：最多 10 条，同 id 去重，最新在前）；
//! - `/approve` 列出这些拒绝，选中一条后发 `thread/approveGuardianDeniedAction`，
//!   `event` 是序列化后的 `codex_protocol::approvals::GuardianAssessmentEvent`
//!   （字段 snake_case，action 以 `type` 区分），与 `protocol_requests.rs` 的转换一致。
//!
//! `writeStdin` 的 cwd 在核心里是 `file:` URI，`requestPermissions` 的权限结构
//! 需要逐字段换形；这两类工作台还没有按官方实现转换，列表里标出且不提交。

use std::collections::VecDeque;

use serde_json::{json, Map, Value};

use crate::features::agents::AgentError;
use crate::models::{PromptAnswer, PromptKind, PromptOption, SessionEventBody};

use super::state::{emit, Pending, Shared};

const MAX_RECENT_DENIALS: usize = 10;

pub(super) const NO_DENIALS: &str = "No recent auto-review denials in this thread.";
pub(super) const NO_DENIALS_HINT: &str = "Denials are recorded after auto-review rejects an action.";
pub(super) const POPUP_TITLE: &str = "Auto-review Denials";
pub(super) const POPUP_SUBTITLE: &str = "Select a denied action to approve.";
pub(super) const NO_RATIONALE: &str = "Auto-review did not include a rationale";
pub(super) const GONE: &str = "That auto-review denial is no longer available.";
pub(super) const APPROVED: &str = "Approval recorded for one retry of the selected auto-review denial.";
pub(super) const APPROVED_HINT: &str =
    "The model will see the approval context; the retry still goes through auto-review.";
pub(super) const UNCONVERTED: &str =
    "工作台还不能把这类拒绝转换成 Codex 的 GuardianAssessmentEvent，未提交。";

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Denial {
    pub id: String,
    pub summary: String,
    pub rationale: Option<String>,
    /// 核心 `GuardianAssessmentEvent`。转换不了时为 None。
    pub event: Option<Value>,
}

#[derive(Debug, Default)]
pub(super) struct RecentDenials {
    entries: VecDeque<Denial>,
}

impl RecentDenials {
    pub(super) fn push(&mut self, denial: Denial) {
        self.entries.retain(|entry| entry.id != denial.id);
        self.entries.push_front(denial);
        self.entries.truncate(MAX_RECENT_DENIALS);
    }

    pub(super) fn entries(&self) -> impl Iterator<Item = &Denial> {
        self.entries.iter()
    }

    pub(super) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub(super) fn take(&mut self, id: &str) -> Option<Denial> {
        let index = self.entries.iter().position(|entry| entry.id == id)?;
        self.entries.remove(index)
    }
}

/// `item/autoApprovalReview/completed` 的参数。只有 denied 才返回。
pub(super) fn denial_from_notification(params: &Value) -> Option<Denial> {
    let review = params.get("review")?;
    if review.get("status").and_then(Value::as_str) != Some("denied") {
        return None;
    }
    let id = params.get("reviewId").and_then(Value::as_str)?.to_string();
    let action = params.get("action")?;
    let rationale = review
        .get("rationale")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(Denial {
        summary: action_summary(action),
        event: assessment_event(params, action),
        id,
        rationale,
    })
}

/// 时间线上的一行。文案取自 TUI `history_cell/approvals.rs` 的 Guardian 拒绝。
pub(super) fn denial_line(params: &Value) -> Option<String> {
    let action = params.get("action")?;
    let kind = action.get("type").and_then(Value::as_str).unwrap_or("");
    Some(match kind {
        "command" | "execve" => {
            let command = action_summary(action);
            if command.trim().is_empty() {
                "✗ Request denied".to_string()
            } else {
                format!("✗ Request denied for codex to run {command}")
            }
        }
        "applyPatch" => {
            let files = string_list(action.get("files"));
            if files.len() == 1 {
                format!("✗ Request denied for codex to apply a patch touching {}", files[0])
            } else {
                format!(
                    "✗ Request denied for codex to apply a patch touching {} files",
                    files.len()
                )
            }
        }
        "writeStdin" => format!("✗ Request denied for codex to {}", action_summary(action)),
        "mcpToolCall" => format!(
            "✗ Request denied for codex to call MCP tool {}.{}",
            text(action, "server"),
            text(action, "toolName")
        ),
        "networkAccess" => format!(
            "✗ Request denied for codex to access {}",
            text(action, "target")
        ),
        _ => format!("✗ Request denied for {}", action_summary(action)),
    })
}

/// `auto_review_denials::action_summary`。
pub(super) fn action_summary(action: &Value) -> String {
    match action.get("type").and_then(Value::as_str).unwrap_or("") {
        "command" => text(action, "command").to_string(),
        "execve" => {
            let argv = string_list(action.get("argv"));
            let command = if argv.is_empty() {
                vec![text(action, "program").to_string()]
            } else {
                argv
            };
            command.iter().map(|arg| shell_quote(arg)).collect::<Vec<_>>().join(" ")
        }
        "writeStdin" => {
            let stdin = format!("{:?}", text(action, "stdin"));
            format!(
                "send input to terminal {}: {}",
                text(action, "processId"),
                truncate_graphemes(&stdin, 80)
            )
        }
        "applyPatch" => {
            let files = string_list(action.get("files"));
            if files.len() == 1 {
                format!("apply_patch touching {}", files[0])
            } else {
                format!("apply_patch touching {} files", files.len())
            }
        }
        "networkAccess" => format!("network access to {}", text(action, "target")),
        "mcpToolCall" => {
            let label = action
                .get("connectorName")
                .and_then(Value::as_str)
                .unwrap_or_else(|| text(action, "server"));
            format!("MCP {} on {label}", text(action, "toolName"))
        }
        "requestPermissions" => action
            .get("reason")
            .and_then(Value::as_str)
            .map(|reason| format!("permission request: {reason}"))
            .unwrap_or_else(|| "permission request".to_string()),
        _ => String::new(),
    }
}

/// app-server 通知 → 核心 `GuardianAssessmentEvent`。字段对照
/// `tui/src/chatwidget/protocol_requests.rs::on_guardian_review_notification`。
fn assessment_event(params: &Value, action: &Value) -> Option<Value> {
    let review = params.get("review")?;
    let mut event = Map::new();
    event.insert("id".into(), params.get("reviewId")?.clone());
    event.insert("turn_id".into(), json!(text(params, "turnId")));
    event.insert(
        "started_at_ms".into(),
        json!(params.get("startedAtMs").and_then(Value::as_i64).unwrap_or(0)),
    );
    if let Some(done) = params.get("completedAtMs").and_then(Value::as_i64) {
        event.insert("completed_at_ms".into(), json!(done));
    }
    event.insert(
        "status".into(),
        json!(camel_to_snake(review.get("status")?.as_str()?)),
    );
    for (from, to) in [("riskLevel", "risk_level"), ("userAuthorization", "user_authorization")] {
        if let Some(value) = review.get(from).and_then(Value::as_str) {
            event.insert(to.into(), json!(camel_to_snake(value)));
        }
    }
    if let Some(rationale) = review.get("rationale").and_then(Value::as_str) {
        event.insert("rationale".into(), json!(rationale));
    }
    if let Some(source) = params.get("decisionSource").and_then(Value::as_str) {
        event.insert("decision_source".into(), json!(camel_to_snake(source)));
    }
    event.insert("action".into(), core_action(action)?);
    Some(Value::Object(event))
}

fn core_action(action: &Value) -> Option<Value> {
    let kind = action.get("type").and_then(Value::as_str)?;
    let mut out = Map::new();
    out.insert("type".into(), json!(camel_to_snake(kind)));
    let fields: &[&str] = match kind {
        "command" => &["source", "command", "cwd"],
        "execve" => &["source", "program", "argv", "cwd"],
        "applyPatch" => &["cwd", "files"],
        "networkAccess" => &["target", "host", "protocol", "port"],
        "mcpToolCall" => &[
            "server",
            "toolName",
            "connectorId",
            "connectorName",
            "toolTitle",
        ],
        _ => return None,
    };
    for field in fields {
        let value = action.get(*field).cloned().unwrap_or(Value::Null);
        let value = match (*field, &value) {
            ("source" | "protocol", Value::String(raw)) => json!(camel_to_snake(raw)),
            _ => value,
        };
        out.insert(camel_to_snake(field), value);
    }
    Some(Value::Object(out))
}

fn camel_to_snake(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 4);
    for ch in raw.chars() {
        if ch.is_ascii_uppercase() {
            out.push('_');
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// `shlex::try_join` 的 POSIX 引号规则。
fn shell_quote(arg: &str) -> String {
    if arg.is_empty() {
        return "''".into();
    }
    let safe = arg
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || "_@%+=:,./-".contains(ch));
    if safe {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

fn truncate_graphemes(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

impl Shared {
    /// `item/autoApprovalReview/completed`。
    pub(super) fn on_auto_review_completed(&self, params: &Value) {
        let ours = self.thread_id.lock().unwrap().clone();
        if ours.as_deref() != params.get("threadId").and_then(Value::as_str) {
            return;
        }
        let Some(denial) = denial_from_notification(params) else {
            return;
        };
        self.denials.lock().unwrap().push(denial);
        if let Some(text) = denial_line(params) {
            emit(&self.events, SessionEventBody::System { text });
        }
    }

    /// `/approve`：`permission_popups.rs::open_auto_review_denials_popup`。
    pub(super) fn open_denials(&self) {
        let denials = self.denials.lock().unwrap();
        if denials.is_empty() {
            emit(
                &self.events,
                SessionEventBody::System {
                    text: format!("{NO_DENIALS}\n{NO_DENIALS_HINT}"),
                },
            );
            return;
        }
        if self.thread_id.lock().unwrap().is_none() {
            emit(
                &self.events,
                SessionEventBody::Error {
                    message: "That thread is no longer available.".into(),
                },
            );
            return;
        }
        let options = denials
            .entries()
            .map(|entry| PromptOption {
                id: entry.id.clone(),
                label: entry.summary.clone(),
                description: entry
                    .rationale
                    .clone()
                    .unwrap_or_else(|| NO_RATIONALE.to_string()),
                ..Default::default()
            })
            .collect();
        drop(denials);
        let prompt_id = format!(
            "approve-denial-{}",
            self.next_id
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        );
        self.pending
            .lock()
            .unwrap()
            .insert(prompt_id.clone(), Pending::ApproveDenial);
        emit(
            &self.events,
            SessionEventBody::Prompt {
                prompt_id,
                prompt_kind: PromptKind::Choice,
                question: format!("{POPUP_TITLE}\n{POPUP_SUBTITLE}"),
                options,
                questions: Vec::new(),
                header: String::new(),
                subtitle: String::new(),
                body: String::new(),
                body_kind: String::new(),
                reason: String::new(),
            },
        );
    }

    /// `approve_recent_auto_review_denial` → `thread/approveGuardianDeniedAction`。
    pub(super) async fn approve_denial(
        &self,
        prompt_id: &str,
        answer: &PromptAnswer,
    ) -> Result<(), AgentError> {
        let PromptAnswer::Single { value } = answer else {
            return Err(AgentError::Runtime(GONE.into()));
        };
        let Some(denial) = self.denials.lock().unwrap().take(value.trim()) else {
            self.resolve_prompt(prompt_id, value.clone());
            emit(
                &self.events,
                SessionEventBody::Error {
                    message: GONE.into(),
                },
            );
            return Ok(());
        };
        let Some(event) = denial.event.clone() else {
            self.denials.lock().unwrap().push(denial);
            self.pending
                .lock()
                .unwrap()
                .insert(prompt_id.to_string(), Pending::ApproveDenial);
            return Err(AgentError::Runtime(UNCONVERTED.into()));
        };
        let thread_id = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Runtime("That thread is no longer available.".into()))?;
        self.request(
            "thread/approveGuardianDeniedAction",
            json!({ "threadId": thread_id, "event": event }),
        )
        .await?;
        self.resolve_prompt(prompt_id, denial.summary.clone());
        emit(
            &self.events,
            SessionEventBody::System {
                text: format!("{APPROVED}\n{APPROVED_HINT}"),
            },
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn denied(id: &str, command: &str) -> Value {
        json!({
            "threadId": "t1",
            "turnId": "turn-1",
            "startedAtMs": 10,
            "completedAtMs": 20,
            "reviewId": id,
            "targetItemId": null,
            "decisionSource": "agent",
            "review": {
                "status": "denied",
                "riskLevel": "high",
                "userAuthorization": "low",
                "rationale": "Deletes files outside the task."
            },
            "action": { "type": "command", "source": "unifiedExec", "command": command, "cwd": "/repo" }
        })
    }

    #[test]
    fn denied_review_becomes_core_assessment_event() {
        let denial = denial_from_notification(&denied("review-1", "rm -rf /tmp/x")).unwrap();
        assert_eq!(denial.summary, "rm -rf /tmp/x");
        assert_eq!(denial.rationale.as_deref(), Some("Deletes files outside the task."));
        let event = denial.event.unwrap();
        assert_eq!(
            event,
            json!({
                "id": "review-1",
                "turn_id": "turn-1",
                "started_at_ms": 10,
                "completed_at_ms": 20,
                "status": "denied",
                "risk_level": "high",
                "user_authorization": "low",
                "rationale": "Deletes files outside the task.",
                "decision_source": "agent",
                "action": {
                    "type": "command",
                    "source": "unified_exec",
                    "command": "rm -rf /tmp/x",
                    "cwd": "/repo"
                }
            })
        );
    }

    #[test]
    fn only_denials_are_recorded() {
        let mut approved = denied("review-2", "ls");
        approved["review"]["status"] = json!("approved");
        assert!(denial_from_notification(&approved).is_none());
        approved["review"]["status"] = json!("timedOut");
        assert!(denial_from_notification(&approved).is_none());
    }

    #[test]
    fn recent_denials_keep_ten_newest_without_duplicates() {
        let mut recent = RecentDenials::default();
        for index in 0..12 {
            let denial =
                denial_from_notification(&denied(&format!("review-{index}"), "ls")).unwrap();
            recent.push(denial);
        }
        let again = denial_from_notification(&denied("review-5", "ls")).unwrap();
        recent.push(again);
        let ids: Vec<_> = recent.entries().map(|entry| entry.id.clone()).collect();
        assert_eq!(ids.len(), 10);
        assert_eq!(ids[0], "review-5");
        assert_eq!(ids.iter().filter(|id| *id == "review-5").count(), 1);
        assert!(recent.take("review-5").is_some());
        assert!(recent.take("review-5").is_none());
    }

    #[test]
    fn summaries_follow_the_tui() {
        assert_eq!(
            action_summary(&json!({ "type": "execve", "program": "git", "argv": ["git", "commit", "-m", "it's"] })),
            "git commit -m 'it'\\''s'"
        );
        assert_eq!(
            action_summary(&json!({ "type": "applyPatch", "cwd": "/r", "files": ["a.rs", "b.rs"] })),
            "apply_patch touching 2 files"
        );
        assert_eq!(
            action_summary(&json!({ "type": "mcpToolCall", "server": "s", "toolName": "t", "connectorName": "Drive" })),
            "MCP t on Drive"
        );
        assert_eq!(
            action_summary(&json!({ "type": "networkAccess", "target": "https://x.dev" })),
            "network access to https://x.dev"
        );
    }

    #[test]
    fn unconverted_actions_are_listed_without_an_event() {
        let mut params = denied("review-9", "");
        params["action"] = json!({
            "type": "writeStdin", "approvalId": "a", "processId": "7", "stdin": "y\n", "cwd": "/r"
        });
        let denial = denial_from_notification(&params).unwrap();
        assert!(denial.event.is_none());
        assert_eq!(denial.summary, "send input to terminal 7: \"y\\n\"");
    }
}
