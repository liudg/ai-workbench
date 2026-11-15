//! 时间线归并：适配器发来的一条事件体，是覆盖已有的一条，还是追加一条新的。
//!
//! 流式输出（同一 `stream_id` 的助手消息、思考、工具调用、计划正文）和按回合覆盖的
//! 差异、文件变更、计划步骤，都改写已有那条并沿用原来的 id 和 seq。
//! 子 Agent 卡片按 `subagent_id` 覆盖；子 Agent 的步骤只和同一个子 Agent 的步骤比。

use crate::models::{SessionEvent, SessionEventBody, SubagentStatus};

/// 能覆盖时改写 `events` 里的那一条，返回它的下标；否则返回 None，调用方追加。
pub fn merge_into(events: &mut [SessionEvent], body: &SessionEventBody, now: i64) -> Option<usize> {
    // 从最新的往回找，流式输出改的几乎总是最后几条；不会覆盖别人的事件不用找。
    let index = match body {
        SessionEventBody::SubagentStep { subagent_id, step } => {
            if !can_overwrite(step) {
                return None;
            }
            let index = events.iter().rposition(|event| match &event.body {
                SessionEventBody::SubagentStep { subagent_id: id, step: existing } => {
                    id == subagent_id && overwrites(existing, step)
                }
                _ => false,
            })?;
            if let SessionEventBody::SubagentStep { step: existing, .. } = &mut events[index].body {
                overwrite(existing, step);
            }
            index
        }
        _ => {
            if !can_overwrite(body) {
                return None;
            }
            let index = events.iter().rposition(|event| overwrites(&event.body, body))?;
            overwrite(&mut events[index].body, body);
            index
        }
    };
    events[index].ts = now;
    Some(index)
}

/// 这种事件有可能覆盖已有的一条。
fn can_overwrite(body: &SessionEventBody) -> bool {
    matches!(
        body,
        SessionEventBody::TurnDiff { .. }
            | SessionEventBody::FileChange { .. }
            | SessionEventBody::TurnChanges { .. }
            | SessionEventBody::PlanSteps { .. }
            | SessionEventBody::Subagent(_)
            | SessionEventBody::PlanText { stream_id: Some(_), .. }
            | SessionEventBody::ToolCall { stream_id: Some(_), .. }
            | SessionEventBody::AgentMessage { stream_id: Some(_), .. }
            | SessionEventBody::Thinking { stream_id: Some(_), .. }
    )
}

fn overwrites(existing: &SessionEventBody, body: &SessionEventBody) -> bool {
    same_key(existing, body) || same_stream(existing, body)
}

fn overwrite(existing: &mut SessionEventBody, body: &SessionEventBody) {
    if !merge_stream(existing, body) {
        *existing = body.clone();
    }
}

/// 这条事件让一张还在跑的卡片结束时，返回要接着记的结束事件。在 `merge_into` 之前调用。
/// 第一次出现就已结束的卡片（分叉复制的时间线）不算：结束事件会跟着一起复制。
pub fn subagent_ended(events: &[SessionEvent], body: &SessionEventBody) -> Option<SessionEventBody> {
    let SessionEventBody::Subagent(card) = body else {
        return None;
    };
    if card.status == SubagentStatus::Running {
        return None;
    }
    let was_running = events.iter().rev().find_map(|event| match &event.body {
        SessionEventBody::Subagent(existing) if existing.subagent_id == card.subagent_id => {
            Some(existing.status == SubagentStatus::Running)
        }
        _ => None,
    })?;
    was_running.then(|| SessionEventBody::SubagentEnded {
        subagent_id: card.subagent_id.clone(),
        title: card.title.clone(),
        status: card.status,
    })
}

/// 按回合、路径、`stream_id` 或子 Agent 整条替换的事件，是不是同一条。
fn same_key(existing: &SessionEventBody, body: &SessionEventBody) -> bool {
    match (existing, body) {
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
        (SessionEventBody::Subagent(existing), SessionEventBody::Subagent(card)) => {
            existing.subagent_id == card.subagent_id
        }
        _ => false,
    }
}

/// 同一 `stream_id` 的助手消息，或同一 `stream_id` 的思考。两种不混。
fn same_stream(existing: &SessionEventBody, body: &SessionEventBody) -> bool {
    match (existing, body) {
        (
            SessionEventBody::AgentMessage { stream_id: Some(existing), .. },
            SessionEventBody::AgentMessage { stream_id: Some(stream_id), .. },
        )
        | (
            SessionEventBody::Thinking { stream_id: Some(existing), .. },
            SessionEventBody::Thinking { stream_id: Some(stream_id), .. },
        ) => existing == stream_id,
        _ => false,
    }
}

/// 同一条流的助手消息或思考：正文换成新的，阶段、模式、去重标记只在新值有内容时更新。
/// 不是这两种时什么都不做，返回 false。
fn merge_stream(existing: &mut SessionEventBody, body: &SessionEventBody) -> bool {
    match (existing, body) {
        (
            SessionEventBody::AgentMessage {
                text: slot,
                phase: slot_phase,
                mode: slot_mode,
                dedupe_of: slot_dedupe,
                ..
            },
            SessionEventBody::AgentMessage { text, phase, mode, dedupe_of, .. },
        ) => {
            slot.clone_from(text);
            if phase.is_some() {
                *slot_phase = *phase;
            }
            if mode.is_some() {
                slot_mode.clone_from(mode);
            }
            if dedupe_of.is_some() {
                slot_dedupe.clone_from(dedupe_of);
            }
            true
        }
        (SessionEventBody::Thinking { text: slot, .. }, SessionEventBody::Thinking { text, .. }) => {
            slot.clone_from(text);
            true
        }
        _ => false,
    }
}

/// 用户或模型的一轮内容。状态、系统说明、只读通知和错误都不算新活动。
pub fn is_conversation_activity(body: &SessionEventBody) -> bool {
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
            | SessionEventBody::Subagent(_)
            | SessionEventBody::SubagentStep { .. }
            | SessionEventBody::SubagentEnded { .. }
    )
}

/// 从第一条用户消息取标题：首行前 24 个字。没有正文时用批注数或「图片」。
pub fn title_from_user_message(text: &str, images: usize, annotations: u32) -> Option<String> {
    let owned = if !text.trim().is_empty() {
        text.to_string()
    } else if annotations > 0 {
        format!("{annotations} 条注释")
    } else if images > 0 {
        "图片".to_string()
    } else {
        return None;
    };
    let first_line = owned.lines().next().unwrap_or("").trim();
    let title: String = first_line.chars().take(24).collect();
    (!title.is_empty()).then_some(title)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MessagePhase;

    fn event(seq: u64, body: SessionEventBody) -> SessionEvent {
        SessionEvent {
            id: format!("e{seq}"),
            session_id: "s".into(),
            seq,
            ts: 0,
            body,
        }
    }

    fn message(text: &str, stream: &str, phase: Option<MessagePhase>) -> SessionEventBody {
        SessionEventBody::AgentMessage {
            text: text.into(),
            stream_id: Some(stream.into()),
            phase,
            mode: None,
            dedupe_of: None,
        }
    }

    #[test]
    fn same_stream_overwrites_and_keeps_phase() {
        let mut events = vec![event(1, message("你", "m1", Some(MessagePhase::Commentary)))];
        let index = merge_into(&mut events, &message("你好", "m1", None), 9).unwrap();
        assert_eq!(index, 0);
        assert_eq!(events[0].ts, 9);
        match &events[0].body {
            SessionEventBody::AgentMessage { text, phase, .. } => {
                assert_eq!(text, "你好");
                assert_eq!(*phase, Some(MessagePhase::Commentary));
            }
            other => panic!("{other:?}"),
        }
        assert!(merge_into(&mut events, &message("新", "m2", None), 9).is_none());
    }

    #[test]
    fn thinking_and_message_streams_do_not_mix() {
        let mut events = vec![event(1, message("答", "x", None))];
        let thinking = SessionEventBody::Thinking {
            text: "想".into(),
            stream_id: Some("x".into()),
        };
        assert!(merge_into(&mut events, &thinking, 1).is_none());
    }

    fn step(subagent: &str, body: SessionEventBody) -> SessionEventBody {
        SessionEventBody::SubagentStep {
            subagent_id: subagent.into(),
            step: Box::new(body),
        }
    }

    /// 子 Agent 的步骤只和同一个子 Agent 的步骤合并；卡片按 id 整条替换。
    #[test]
    fn a_card_ending_is_reported_once() {
        let mut card = crate::models::SubagentCard::new("a", "查一下");
        let mut events = vec![event(1, SessionEventBody::Subagent(card.clone()))];
        assert!(subagent_ended(&events, &SessionEventBody::Subagent(card.clone())).is_none());
        card.finish(SubagentStatus::Failed, Some(2));
        let body = SessionEventBody::Subagent(card.clone());
        assert!(matches!(
            subagent_ended(&events, &body),
            Some(SessionEventBody::SubagentEnded { status: SubagentStatus::Failed, .. })
        ));
        merge_into(&mut events, &body, 3);
        assert!(subagent_ended(&events, &body).is_none());
        // 复制过来的时间线里，第一次见到就已结束。
        assert!(subagent_ended(&[], &body).is_none());
    }

    #[test]
    fn subagent_steps_merge_within_their_subagent() {
        let mut events = vec![
            event(1, message("主线", "m1", None)),
            event(2, step("a", message("子", "m1", None))),
            event(3, step("b", message("另一个", "m1", None))),
        ];
        let index = merge_into(&mut events, &step("a", message("子回答", "m1", None)), 7).unwrap();
        assert_eq!(index, 1);
        match &events[1].body {
            SessionEventBody::SubagentStep { step, .. } => {
                assert!(matches!(&**step, SessionEventBody::AgentMessage { text, .. } if text == "子回答"))
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(&events[0].body, SessionEventBody::AgentMessage { text, .. } if text == "主线"));
        assert!(merge_into(&mut events, &step("c", message("新", "m1", None)), 7).is_none());

        let mut card = crate::models::SubagentCard::new("a", "查一下");
        events.push(event(4, SessionEventBody::Subagent(card.clone())));
        card.result = "查完了".into();
        assert_eq!(merge_into(&mut events, &SessionEventBody::Subagent(card), 8), Some(3));
        assert!(matches!(&events[3].body, SessionEventBody::Subagent(card) if card.result == "查完了"));
    }

    #[test]
    fn title_uses_first_line() {
        assert_eq!(title_from_user_message("  修一下登录\n细节", 0, 0).as_deref(), Some("修一下登录"));
        assert_eq!(title_from_user_message("", 1, 0).as_deref(), Some("图片"));
        assert_eq!(title_from_user_message("", 0, 2).as_deref(), Some("2 条注释"));
        assert_eq!(title_from_user_message(" ", 0, 0), None);
    }
}
