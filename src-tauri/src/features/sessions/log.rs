//! 会话事件日志。追加、覆盖同一条流，以及把更早的回合插到前面。
//! 侧边栏排序时间也在这里算：打开、附着、状态变化，以及 resume 改写的目录时间，都不算新活动。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::features::agents::AgentSession;
use crate::models::*;

/// 前端事件名约定
pub const EVT_SESSION_EVENT: &str = "session-event";
pub const EVT_SESSIONS_CHANGED: &str = "sessions-changed";
pub const EVT_SESSION_QUEUE: &str = "session-queue";
/// 适配器请求宿主新开会话（`SessionEventBody::NewThread`）。不进时间线。
pub const EVT_SESSION_REQUEST: &str = "session-request";

/// 把事件推给前端。桌面版是 Tauri `emit`，网页预览的 dev bridge 是 SSE。
pub type EventEmitter = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

pub(super) struct SessionEntry {
    pub(super) meta: Session,
    /// 完整事件日志（切换会话时通过 `get_session_events` 全量拉取）
    pub(super) events: Vec<SessionEvent>,
    pub(super) next_seq: u64,
    pub(super) agent: Option<Arc<dyn AgentSession>>,
    /// 这次连接之后真正发生过对话才有值。打开、附着、状态变化不算。
    pub(super) activity_at: Option<i64>,
    /// 作曲栏排队。不进时间线。
    pub(super) queue: Vec<QueuedTurn>,
    /// 第一条用户消息落地前不进侧栏。
    pub(super) withhold_sidebar: bool,
}

pub(super) fn apply_body(
    entries: &Mutex<HashMap<SessionId, SessionEntry>>,
    emit: &EventEmitter,
    session_id: &str,
    body: SessionEventBody,
    record_activity: bool,
) {
    if let SessionEventBody::NewThread {
        name,
        text,
        worktree,
    } = body
    {
        let (project_id, agent) = {
            let entries = entries.lock().unwrap();
            let Some(entry) = entries.get(session_id) else {
                return;
            };
            (entry.meta.project_id.clone(), entry.meta.agent)
        };
        emit(
            EVT_SESSION_REQUEST,
            serde_json::json!({
                "session_id": session_id,
                "project_id": project_id,
                "agent": agent,
                "name": name,
                "text": text,
                "worktree": worktree,
            }),
        );
        return;
    }
    if let SessionEventBody::QueueChanged { items } = body {
        {
            let mut entries = entries.lock().unwrap();
            if let Some(entry) = entries.get_mut(session_id) {
                entry.queue = items.clone();
            }
        }
        emit(
            EVT_SESSION_QUEUE,
            serde_json::json!({ "session_id": session_id, "items": items }),
        );
        return;
    }
    let replaced = {
        let mut entries = entries.lock().unwrap();
        let Some(entry) = entries.get_mut(session_id) else {
            return;
        };
        replace_stream(entry, &body, record_activity)
    };
    if let Some(event) = replaced {
        emit(EVT_SESSION_EVENT, event_value(&event));
        return;
    }

    let (event, project_id, notify) = {
        let mut entries = entries.lock().unwrap();
        let Some(entry) = entries.get_mut(session_id) else {
            return;
        };
        let outcome = mutate_entry(entry, session_id, body, record_activity);
        (outcome.event, outcome.project_id, outcome.notify)
    };
    emit(EVT_SESSION_EVENT, event_value(&event));
    if notify {
        emit(
            EVT_SESSIONS_CHANGED,
            serde_json::json!({ "project_id": project_id }),
        );
    }
}

struct EntryMutation {
    event: SessionEvent,
    project_id: String,
    notify: bool,
}

fn mutate_entry(
    entry: &mut SessionEntry,
    session_id: &str,
    body: SessionEventBody,
    record_activity: bool,
) -> EntryMutation {
    let status_changed = matches!(body, SessionEventBody::StatusChanged { .. });
    if let SessionEventBody::StatusChanged { status } = &body {
        entry.meta.status = *status;
    }
    let mut title_changed = false;
    if let SessionEventBody::UserMessage {
        text,
        images,
        annotations,
    } = &body
    {
        entry.withhold_sidebar = false;
        if entry.meta.title.starts_with("会话 ") || entry.meta.title == "未命名会话" {
            let owned = if !text.trim().is_empty() {
                text.clone()
            } else if *annotations > 0 {
                format!("{annotations} 条注释")
            } else if !images.is_empty() {
                "图片".to_string()
            } else {
                String::new()
            };
            let first_line = owned.lines().next().unwrap_or("");
            let title: String = first_line.chars().take(24).collect();
            if !title.is_empty() {
                entry.meta.title = title;
                title_changed = true;
            }
        }
    }
    let now = now_millis();
    if record_activity && is_conversation_activity(&body) {
        note_activity(entry, now);
    }
    let event = SessionEvent {
        id: new_id(),
        session_id: session_id.to_string(),
        seq: entry.next_seq,
        ts: now,
        body,
    };
    entry.next_seq += 1;
    entry.events.push(event.clone());
    EntryMutation {
        event,
        project_id: entry.meta.project_id.clone(),
        notify: status_changed || title_changed,
    }
}

/// 用户或模型的一轮内容。状态、系统说明、只读通知和错误都不改排序时间。
fn is_conversation_activity(body: &SessionEventBody) -> bool {
    matches!(
        body,
        SessionEventBody::UserMessage { .. }
            | SessionEventBody::AgentMessage { .. }
            | SessionEventBody::Thinking { .. }
            | SessionEventBody::ToolCall { .. }
            | SessionEventBody::Prompt { .. }
            | SessionEventBody::PromptResolved { .. }
            | SessionEventBody::PlanSteps { .. }
            | SessionEventBody::PlanText { .. }
            | SessionEventBody::ReviewFindings { .. }
            | SessionEventBody::TurnDiff { .. }
            | SessionEventBody::FileChange { .. }
            | SessionEventBody::TurnChanges { .. }
    )
}

/// 更早的回合插到日志前面。已有事件的 seq 整体上移，新插入的页使用更小的序号。
pub(super) fn prepend_bodies(
    entry: &mut SessionEntry,
    session_id: &str,
    bodies: Vec<SessionEventBody>,
) -> usize {
    let added = bodies.len();
    if added == 0 {
        return 0;
    }
    let shift = added as u64;
    for event in &mut entry.events {
        event.seq = event.seq.saturating_add(shift);
    }
    entry.next_seq = entry.next_seq.saturating_add(shift);
    let now = now_millis();
    let mut older = Vec::with_capacity(added);
    for (index, body) in bodies.into_iter().enumerate() {
        older.push(SessionEvent {
            id: new_id(),
            session_id: session_id.to_string(),
            seq: index as u64 + 1,
            ts: now,
            body,
        });
    }
    older.append(&mut entry.events);
    entry.events = older;
    added
}

fn note_activity(entry: &mut SessionEntry, at: i64) {
    entry.activity_at = Some(at);
    entry.meta.updated_at = at;
}

/// 侧边栏排序时间。
///
/// 有真实对话时，目录时间和这次活动取较新的。
/// 没有真实对话时，打开时记下的时间如果更早就留在那里：
/// resume 可能把目录 `updated_at` 改到现在，那不是新的一轮。
/// 内存里的时间如果比目录还新，也仍然用目录，避免打开流程自己把时间改掉。
pub(super) fn sidebar_updated_at(
    directory_updated_at: i64,
    activity_at: Option<i64>,
    opened_updated_at: i64,
) -> i64 {
    match activity_at {
        Some(activity) => directory_updated_at.max(activity),
        None => directory_updated_at.min(opened_updated_at),
    }
}

fn replace_keyed(
    entry: &mut SessionEntry,
    body: &SessionEventBody,
    record_activity: bool,
) -> Option<SessionEvent> {
    let existing = entry
        .events
        .iter_mut()
        .rev()
        .find(|event| match (&event.body, body) {
            (
                SessionEventBody::TurnDiff {
                    turn_id: existing, ..
                },
                SessionEventBody::TurnDiff { turn_id, .. },
            ) => existing == turn_id,
            (
                SessionEventBody::FileChange {
                    turn_id: existing,
                    path: existing_path,
                    ..
                },
                SessionEventBody::FileChange { turn_id, path, .. },
            ) => existing == turn_id && existing_path == path,
            (
                SessionEventBody::TurnChanges {
                    turn_id: existing, ..
                },
                SessionEventBody::TurnChanges { turn_id, .. },
            ) => existing == turn_id,
            (
                SessionEventBody::PlanSteps {
                    turn_id: existing, ..
                },
                SessionEventBody::PlanSteps { turn_id, .. },
            ) => existing == turn_id,
            (
                SessionEventBody::PlanText {
                    stream_id: Some(existing),
                    ..
                },
                SessionEventBody::PlanText {
                    stream_id: Some(stream_id),
                    ..
                },
            ) => existing == stream_id,
            (
                SessionEventBody::ToolCall {
                    stream_id: Some(existing),
                    ..
                },
                SessionEventBody::ToolCall {
                    stream_id: Some(stream_id),
                    ..
                },
            ) => existing == stream_id,
            _ => false,
        })?;
    existing.body = body.clone();
    let at = now_millis();
    existing.ts = at;
    let event = existing.clone();
    if record_activity {
        note_activity(entry, at);
    }
    Some(event)
}

/// 同一 `stream_id` 的助手消息或思考覆盖上一条，并沿用原来的事件 id。
fn replace_stream(
    entry: &mut SessionEntry,
    body: &SessionEventBody,
    record_activity: bool,
) -> Option<SessionEvent> {
    if let Some(event) = replace_keyed(entry, body, record_activity) {
        return Some(event);
    }
    let (text, stream_id, thinking, phase, mode, dedupe_of) = match body {
        SessionEventBody::AgentMessage {
            text,
            stream_id: Some(stream_id),
            phase,
            mode,
            dedupe_of,
        } => (
            text,
            stream_id,
            false,
            *phase,
            mode.clone(),
            dedupe_of.clone(),
        ),
        SessionEventBody::Thinking {
            text,
            stream_id: Some(stream_id),
        } => (text, stream_id, true, None, None, None),
        _ => return None,
    };
    let existing = entry
        .events
        .iter_mut()
        .rev()
        .find(|event| match &event.body {
            SessionEventBody::AgentMessage {
                stream_id: Some(id),
                ..
            } if !thinking => id == stream_id,
            SessionEventBody::Thinking {
                stream_id: Some(id),
                ..
            } if thinking => id == stream_id,
            _ => false,
        })?;
    match &mut existing.body {
        SessionEventBody::AgentMessage {
            text: slot,
            phase: slot_phase,
            mode: slot_mode,
            dedupe_of: slot_dedupe,
            ..
        } if !thinking => {
            *slot = text.clone();
            if let Some(phase) = phase {
                *slot_phase = Some(phase);
            }
            if mode.is_some() {
                *slot_mode = mode;
            }
            if dedupe_of.is_some() {
                *slot_dedupe = dedupe_of;
            }
        }
        SessionEventBody::Thinking { text: slot, .. } if thinking => *slot = text.clone(),
        _ => return None,
    }
    let at = now_millis();
    existing.ts = at;
    let event = existing.clone();
    if record_activity {
        note_activity(entry, at);
    }
    Some(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(updated_at: i64) -> SessionEntry {
        SessionEntry {
            meta: Session {
                id: "codex-cli:thread".into(),
                project_id: "p".into(),
                agent: AgentKind::CodexCli,
                native_id: "thread".into(),
                title: "概括当前项目".into(),
                status: SessionStatus::Completed,
                created_at: updated_at - 1_000,
                updated_at,
                archived: false,
                workdir: None,
                worktree_branch: None,
                worktree_base: None,
                worktree_sha: None,
                worktree_owned: false,
            },
            events: Vec::new(),
            next_seq: 1,
            agent: None,
            activity_at: None,
            queue: Vec::new(),
            withhold_sidebar: false,
        }
    }

    #[test]
    fn user_message_releases_a_withheld_sidebar_row() {
        let mut session = entry(1_000);
        session.withhold_sidebar = true;
        session.meta.title = "未命名会话".into();
        mutate_entry(
            &mut session,
            "codex-cli:thread",
            SessionEventBody::StatusChanged {
                status: SessionStatus::Running,
            },
            false,
        );
        assert!(session.withhold_sidebar);
        mutate_entry(
            &mut session,
            "codex-cli:thread",
            SessionEventBody::UserMessage {
                text: "你好".into(),
                images: Vec::new(),
                annotations: 0,
            },
            true,
        );
        assert!(!session.withhold_sidebar);
    }

    #[test]
    fn open_and_status_keep_the_directory_sort_time() {
        let mut session = entry(1_000);
        mutate_entry(
            &mut session,
            "codex-cli:thread",
            SessionEventBody::System {
                text: "Codex CLI 已连接".into(),
            },
            false,
        );
        mutate_entry(
            &mut session,
            "codex-cli:thread",
            SessionEventBody::UserMessage {
                text: "历史里的问题".into(),
                images: Vec::new(),
                annotations: 0,
            },
            false,
        );
        mutate_entry(
            &mut session,
            "codex-cli:thread",
            SessionEventBody::AgentMessage {
                text: "历史回答".into(),
                stream_id: None,
                phase: None,
                mode: None,
                dedupe_of: None,
            },
            false,
        );
        mutate_entry(
            &mut session,
            "codex-cli:thread",
            SessionEventBody::StatusChanged {
                status: SessionStatus::Completed,
            },
            false,
        );
        mutate_entry(
            &mut session,
            "codex-cli:thread",
            SessionEventBody::StatusChanged {
                status: SessionStatus::Running,
            },
            true,
        );
        assert_eq!(session.activity_at, None);
        assert_eq!(session.meta.updated_at, 1_000);
        assert_eq!(session.meta.status, SessionStatus::Running);
        assert_eq!(
            sidebar_updated_at(1_000, session.activity_at, session.meta.updated_at),
            1_000
        );
        session.meta.updated_at = 9_999_999;
        assert_eq!(
            sidebar_updated_at(1_000, session.activity_at, session.meta.updated_at),
            1_000
        );
        assert_eq!(sidebar_updated_at(9_999_999, None, 1_000), 1_000);
    }

    #[test]
    fn a_live_turn_sorts_by_the_newer_activity_time() {
        let mut session = entry(1_000);
        session.meta.title = "未命名会话".into();
        mutate_entry(
            &mut session,
            "codex-cli:thread",
            SessionEventBody::UserMessage {
                text: "概括当前项目\n第二行".into(),
                images: Vec::new(),
                annotations: 0,
            },
            true,
        );
        let activity = session.activity_at.expect("live turn");
        assert!(activity >= 1_000);
        assert_eq!(session.meta.updated_at, activity);
        assert_eq!(session.meta.title, "概括当前项目");
        assert_eq!(
            sidebar_updated_at(1_000, session.activity_at, session.meta.updated_at),
            activity
        );
        assert_eq!(
            sidebar_updated_at(activity + 50, session.activity_at, 1_000),
            activity + 50
        );
    }

    #[test]
    fn replay_can_rename_without_bumping() {
        let mut session = entry(1_000);
        session.meta.title = "未命名会话".into();
        mutate_entry(
            &mut session,
            "codex-cli:thread",
            SessionEventBody::UserMessage {
                text: "概括当前项目".into(),
                images: Vec::new(),
                annotations: 0,
            },
            false,
        );
        assert_eq!(session.meta.title, "概括当前项目");
        assert_eq!(session.activity_at, None);
        assert_eq!(session.meta.updated_at, 1_000);
    }

    #[test]
    fn image_only_message_uses_a_picture_title() {
        let mut session = entry(1_000);
        session.meta.title = "未命名会话".into();
        mutate_entry(
            &mut session,
            "codex-cli:thread",
            SessionEventBody::UserMessage {
                text: String::new(),
                images: vec!["C:/shot.png".into()],
                annotations: 0,
            },
            true,
        );
        assert_eq!(session.meta.title, "图片");
    }

    #[test]
    fn streamed_replies_count_only_after_open() {
        let mut session = entry(1_000);
        mutate_entry(
            &mut session,
            "codex-cli:thread",
            SessionEventBody::AgentMessage {
                text: "先".into(),
                stream_id: Some("s1".into()),
                phase: None,
                mode: None,
                dedupe_of: None,
            },
            false,
        );
        assert!(replace_stream(
            &mut session,
            &SessionEventBody::AgentMessage {
                text: "先看目录".into(),
                stream_id: Some("s1".into()),
                phase: None,
                mode: None,
                dedupe_of: None,
            },
            false,
        )
        .is_some());
        assert_eq!(session.activity_at, None);
        assert_eq!(session.meta.updated_at, 1_000);

        assert!(replace_stream(
            &mut session,
            &SessionEventBody::AgentMessage {
                text: "先看目录结构".into(),
                stream_id: Some("s1".into()),
                phase: Some(crate::models::MessagePhase::Commentary),
                mode: Some("plan".into()),
                dedupe_of: Some("rev-1".into()),
            },
            true,
        )
        .is_some());
        assert_eq!(session.activity_at, Some(session.meta.updated_at));
        assert!(session.meta.updated_at >= 1_000);
        match &session.events[0].body {
            SessionEventBody::AgentMessage {
                text,
                phase,
                mode,
                dedupe_of,
                ..
            } => {
                assert_eq!(text, "先看目录结构");
                assert_eq!(phase, &Some(crate::models::MessagePhase::Commentary));
                assert_eq!(mode.as_deref(), Some("plan"));
                assert_eq!(dedupe_of.as_deref(), Some("rev-1"));
            }
            other => panic!("expected streamed agent message, got {other:?}"),
        }
    }

    #[test]
    fn a_later_turn_does_not_overwrite_the_earlier_assistant_bubble() {
        let mut session = entry(1_000);
        let apply = |session: &mut SessionEntry, body: SessionEventBody| {
            if replace_stream(session, &body, false).is_none() {
                mutate_entry(session, "codex-cli:thread", body, false);
            }
        };
        apply(
            &mut session,
            SessionEventBody::UserMessage {
                text: "介绍一下自己".into(),
                images: Vec::new(),
                annotations: 0,
            },
        );
        apply(
            &mut session,
            SessionEventBody::AgentMessage {
                text: "我".into(),
                stream_id: Some("assistant:turn-1:1".into()),
                phase: Some(crate::models::MessagePhase::PartialAnswer),
                mode: None,
                dedupe_of: None,
            },
        );
        let bubble = session.events[1].id.clone();
        apply(
            &mut session,
            SessionEventBody::AgentMessage {
                text: "我是上一轮".into(),
                stream_id: Some("assistant:turn-1:1".into()),
                phase: Some(crate::models::MessagePhase::FinalAnswer),
                mode: None,
                dedupe_of: None,
            },
        );
        apply(
            &mut session,
            SessionEventBody::UserMessage {
                text: "再说一次".into(),
                images: Vec::new(),
                annotations: 0,
            },
        );
        apply(
            &mut session,
            SessionEventBody::AgentMessage {
                text: "我是这一轮".into(),
                stream_id: Some("assistant:44444444-4444-4444-8444-444444444444".into()),
                phase: Some(crate::models::MessagePhase::FinalAnswer),
                mode: None,
                dedupe_of: None,
            },
        );
        assert_eq!(session.events[1].id, bubble);
        let texts: Vec<_> = session
            .events
            .iter()
            .filter_map(|event| match &event.body {
                SessionEventBody::UserMessage { text, .. }
                | SessionEventBody::AgentMessage { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            texts,
            vec!["介绍一下自己", "我是上一轮", "再说一次", "我是这一轮"]
        );
    }

    fn stamped(seq: u64, body: SessionEventBody) -> SessionEvent {
        SessionEvent {
            id: seq.to_string(),
            session_id: "codex-cli:thread".into(),
            seq,
            ts: seq as i64,
            body,
        }
    }

    #[test]
    fn older_history_is_prepended_without_moving_activity() {
        let mut session = entry(1_000);
        session.events = vec![
            stamped(
                1,
                SessionEventBody::UserMessage {
                    text: "new".into(),
                    images: Vec::new(),
                    annotations: 0,
                },
            ),
            stamped(
                2,
                SessionEventBody::TurnAnchor {
                    turn_id: "new".into(),
                    mode: None,
                },
            ),
        ];
        session.next_seq = 3;
        session.activity_at = Some(1_000);
        let added = prepend_bodies(
            &mut session,
            "codex-cli:thread",
            vec![
                SessionEventBody::UserMessage {
                    text: "old".into(),
                    images: Vec::new(),
                    annotations: 0,
                },
                SessionEventBody::ToolCall {
                    name: "command".into(),
                    summary: "echo hi".into(),
                    detail: "hi".into(),
                    stream_id: None,
                    images: Vec::new(),
                },
            ],
        );
        assert_eq!(added, 2);
        assert_eq!(session.events[0].seq, 1);
        assert_eq!(session.events[1].seq, 2);
        assert_eq!(session.events[2].seq, 3);
        assert_eq!(session.events[3].seq, 4);
        assert_eq!(session.next_seq, 5);
        assert_eq!(session.activity_at, Some(1_000));
        assert_eq!(session.meta.updated_at, 1_000);
        assert_eq!(session.events.len(), 4);
        assert!(matches!(
            &session.events[1].body,
            SessionEventBody::ToolCall { detail, .. } if detail == "hi"
        ));
    }

    #[test]
    fn streamed_tool_output_replaces_the_same_card() {
        let mut session = entry(1_000);
        mutate_entry(
            &mut session,
            "codex-cli:thread",
            SessionEventBody::ToolCall {
                name: "command".into(),
                summary: "echo".into(),
                detail: String::new(),
                stream_id: Some("cmd".into()),
                images: Vec::new(),
            },
            false,
        );
        assert!(replace_stream(
            &mut session,
            &SessionEventBody::ToolCall {
                name: "command".into(),
                summary: "echo → completed".into(),
                detail: "hello".into(),
                stream_id: Some("cmd".into()),
                images: Vec::new(),
            },
            false,
        )
        .is_some());
        assert_eq!(session.events.len(), 1);
        assert!(matches!(
            &session.events[0].body,
            SessionEventBody::ToolCall { detail, summary, .. }
                if detail == "hello" && summary == "echo → completed"
        ));
        assert_eq!(session.activity_at, None);
    }
}

fn event_value(event: &SessionEvent) -> serde_json::Value {
    serde_json::to_value(event).unwrap_or(serde_json::Value::Null)
}
