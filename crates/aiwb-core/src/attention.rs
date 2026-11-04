//! 注意力投影：每个会话一行，告诉侧栏、看板和系统通知「这个会话要不要你看」。
//!
//! 状态从会话状态推出；`unread` 只在回合停下来（要你处理、完成、失败）而你没在看这个任务时记上，
//! 看一眼就清掉。照 orca `src/renderer/src/attention/agent-attention-policy.ts`：
//! 正在看的会话照样换状态，但不记未读。

use serde::{Deserialize, Serialize};

use crate::models::{PromptKind, SessionEvent, SessionEventBody, SessionStatus, SubagentStatus};

/// 预览最多留多少个字。
const PREVIEW_CHARS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AttentionState {
    /// 在等审批或回答。
    NeedsInput,
    Failed,
    Working,
    Done,
    /// 还没开始，或者被停掉了。
    Idle,
}

/// 在等你做什么：批准，还是回答问题。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AskKind {
    Approval,
    Input,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attention {
    pub state: AttentionState,
    pub unread: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask: Option<AskKind>,
    /// 最后一句话：提问、错误或 Agent 的回答，单行截短。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    pub updated_at: i64,
}

impl Attention {
    /// 刚建的会话，或者没有投影行的旧数据。
    pub fn from_status(status: SessionStatus, updated_at: i64) -> Self {
        Self {
            state: state_of(status),
            unread: false,
            ask: None,
            preview: None,
            updated_at,
        }
    }
}

pub fn state_of(status: SessionStatus) -> AttentionState {
    match status {
        SessionStatus::Running => AttentionState::Working,
        SessionStatus::NeedsInput => AttentionState::NeedsInput,
        SessionStatus::Completed => AttentionState::Done,
        SessionStatus::Failed => AttentionState::Failed,
        SessionStatus::Stopped => AttentionState::Idle,
    }
}

/// 会话状态变了之后的注意力。状态没变时返回 `None`，不用写库。
/// `viewed`：这时有人正看着这个任务。
pub fn on_status(
    prev: &Attention,
    status: SessionStatus,
    events: &[SessionEvent],
    viewed: bool,
    now: i64,
) -> Option<Attention> {
    let mut state = state_of(status);
    // 主回合结束了，后台的子 Agent 还在跑：仍算在做。
    if state == AttentionState::Done && subagent_running(events) {
        state = AttentionState::Working;
    }
    if state == prev.state {
        return None;
    }
    let unread = match state {
        AttentionState::NeedsInput | AttentionState::Done | AttentionState::Failed => !viewed,
        AttentionState::Working | AttentionState::Idle => false,
    };
    let ask = (state == AttentionState::NeedsInput)
        .then(|| pending_prompt(events).map(|(kind, _)| kind))
        .flatten();
    Some(Attention {
        state,
        unread,
        ask,
        preview: preview(state, events).or_else(|| prev.preview.clone()),
        updated_at: now,
    })
}

/// 子 Agent 卡片变了：按会话最后的状态重算。后台子 Agent 跑完时从「在做」变成「完成」。
pub fn on_subagent(prev: &Attention, events: &[SessionEvent], viewed: bool, now: i64) -> Option<Attention> {
    let status = events.iter().rev().find_map(|event| match &event.body {
        SessionEventBody::StatusChanged { status } => Some(*status),
        _ => None,
    })?;
    on_status(prev, status, events, viewed, now)
}

fn subagent_running(events: &[SessionEvent]) -> bool {
    events.iter().any(|event| {
        matches!(&event.body, SessionEventBody::Subagent(card) if card.status == SubagentStatus::Running)
    })
}

/// 在等输入时来了新的提问或回答：换掉要你做的事和预览，未读不动。
pub fn on_prompt(prev: &Attention, events: &[SessionEvent]) -> Option<Attention> {
    if prev.state != AttentionState::NeedsInput {
        return None;
    }
    let ask = pending_prompt(events).map(|(kind, _)| kind);
    let preview = preview(prev.state, events).or_else(|| prev.preview.clone());
    if ask == prev.ask && preview == prev.preview {
        return None;
    }
    Some(Attention {
        ask,
        preview,
        ..prev.clone()
    })
}

/// 最后一条还没回答的提问。
fn pending_prompt(events: &[SessionEvent]) -> Option<(AskKind, &str)> {
    let resolved: Vec<&str> = events
        .iter()
        .filter_map(|event| match &event.body {
            SessionEventBody::PromptResolved { prompt_id, .. } => Some(prompt_id.as_str()),
            _ => None,
        })
        .collect();
    events.iter().rev().find_map(|event| match &event.body {
        SessionEventBody::Prompt {
            prompt_id,
            prompt_kind,
            question,
            header,
            ..
        } if !resolved.contains(&prompt_id.as_str()) => {
            let kind = match prompt_kind {
                PromptKind::Approval => AskKind::Approval,
                _ => AskKind::Input,
            };
            let text = if question.trim().is_empty() { header } else { question };
            Some((kind, text.as_str()))
        }
        _ => None,
    })
}

/// 这一轮最后说的话。失败时先找这一轮的错误，在等输入时用提问。
fn preview(state: AttentionState, events: &[SessionEvent]) -> Option<String> {
    if state == AttentionState::NeedsInput {
        if let Some((_, text)) = pending_prompt(events) {
            return one_line(text);
        }
    }
    let turn_start = events
        .iter()
        .rposition(|event| matches!(event.body, SessionEventBody::UserMessage { .. }))
        .unwrap_or(0);
    if state == AttentionState::Failed {
        let error = events[turn_start..].iter().rev().find_map(|event| match &event.body {
            SessionEventBody::Error { message } => one_line(message),
            _ => None,
        });
        if error.is_some() {
            return error;
        }
    }
    events.iter().rev().find_map(|event| match &event.body {
        SessionEventBody::AgentMessage { text, dedupe_of: None, .. } => one_line(text),
        _ => None,
    })
}

/// 空白收成一个空格，截到 [`PREVIEW_CHARS`] 个字。
fn one_line(text: &str) -> Option<String> {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.is_empty() {
        return None;
    }
    let mut chars = joined.chars();
    let head: String = chars.by_ref().take(PREVIEW_CHARS).collect();
    Some(if chars.next().is_some() { format!("{head}…") } else { head })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::PromptOption;

    fn event(seq: u64, body: SessionEventBody) -> SessionEvent {
        SessionEvent {
            id: format!("e{seq}"),
            session_id: "s".into(),
            seq,
            ts: seq as i64,
            body,
        }
    }

    fn user(seq: u64, text: &str) -> SessionEvent {
        event(seq, SessionEventBody::UserMessage { text: text.into(), images: vec![], annotations: 0, sender: None })
    }

    fn agent(seq: u64, text: &str) -> SessionEvent {
        event(
            seq,
            SessionEventBody::AgentMessage {
                text: text.into(),
                stream_id: None,
                phase: None,
                mode: None,
                dedupe_of: None,
            },
        )
    }

    fn prompt(seq: u64, id: &str, kind: PromptKind, question: &str) -> SessionEvent {
        event(
            seq,
            SessionEventBody::Prompt {
                prompt_id: id.into(),
                prompt_kind: kind,
                question: question.into(),
                options: Vec::<PromptOption>::new(),
                questions: vec![],
                header: String::new(),
                subtitle: String::new(),
                body: String::new(),
                body_kind: String::new(),
                reason: String::new(),
            },
        )
    }

    fn working() -> Attention {
        Attention::from_status(SessionStatus::Running, 1)
    }

    #[test]
    fn finishing_unwatched_is_unread_and_watched_is_not() {
        let events = [user(1, "修一下"), agent(2, "改好了\n\n  跑过测试")];
        let done = on_status(&working(), SessionStatus::Completed, &events, false, 5).unwrap();
        assert_eq!(done.state, AttentionState::Done);
        assert!(done.unread);
        assert_eq!(done.preview.as_deref(), Some("改好了 跑过测试"));
        assert_eq!(done.updated_at, 5);
        let seen = on_status(&working(), SessionStatus::Completed, &events, true, 5).unwrap();
        assert!(!seen.unread);
    }

    #[test]
    fn same_state_needs_no_write_and_new_turn_clears_unread() {
        let events = [user(1, "hi")];
        assert!(on_status(&working(), SessionStatus::Running, &events, false, 2).is_none());
        let done = on_status(&working(), SessionStatus::Completed, &events, false, 2).unwrap();
        let again = on_status(&done, SessionStatus::Running, &events, false, 3).unwrap();
        assert_eq!(again.state, AttentionState::Working);
        assert!(!again.unread);
        let stopped = on_status(&done, SessionStatus::Stopped, &events, false, 3).unwrap();
        assert_eq!(stopped.state, AttentionState::Idle);
        assert!(!stopped.unread);
    }

    #[test]
    fn waiting_names_the_open_prompt() {
        let events = [
            user(1, "删掉旧文件"),
            prompt(2, "p1", PromptKind::Approval, "运行 rm old.txt"),
            event(3, SessionEventBody::PromptResolved { prompt_id: "p1".into(), answer: "yes".into() }),
            prompt(4, "p2", PromptKind::Questions, "要保留备份吗？"),
        ];
        let waiting = on_status(&working(), SessionStatus::NeedsInput, &events, false, 4).unwrap();
        assert_eq!(waiting.ask, Some(AskKind::Input));
        assert_eq!(waiting.preview.as_deref(), Some("要保留备份吗？"));
        assert!(waiting.unread);

        // 先报状态、提问后到：提问来了再补上。
        let early = on_status(&working(), SessionStatus::NeedsInput, &events[..1], false, 1).unwrap();
        assert_eq!(early.ask, None);
        let filled = on_prompt(&early, &events[..2]).unwrap();
        assert_eq!(filled.ask, Some(AskKind::Approval));
        assert_eq!(filled.preview.as_deref(), Some("运行 rm old.txt"));
        assert!(filled.unread);
        assert!(on_prompt(&filled, &events[..2]).is_none());
        assert!(on_prompt(&working(), &events).is_none());
    }

    #[test]
    fn failure_shows_this_turns_error() {
        let events = [
            agent(1, "上一轮的回答"),
            event(2, SessionEventBody::Error { message: "旧错误".into() }),
            user(3, "再试"),
            event(4, SessionEventBody::Error { message: "连接断开".into() }),
        ];
        let failed = on_status(&working(), SessionStatus::Failed, &events, false, 4).unwrap();
        assert_eq!(failed.preview.as_deref(), Some("连接断开"));
        let no_error = on_status(&working(), SessionStatus::Failed, &events[..3], false, 4).unwrap();
        assert_eq!(no_error.preview.as_deref(), Some("上一轮的回答"));
    }

    /// 主回合完了，后台子 Agent 还在跑：仍算在做。子 Agent 结束后才算完成、记未读。
    #[test]
    fn running_background_subagent_keeps_the_session_working() {
        use crate::models::SubagentCard;
        let mut card = SubagentCard::new("toolu_B", "后台");
        card.background = true;
        let running = [
            user(1, "派个后台子 Agent"),
            event(2, SessionEventBody::Subagent(card.clone())),
            event(3, SessionEventBody::StatusChanged { status: SessionStatus::Completed }),
        ];
        assert!(on_status(&working(), SessionStatus::Completed, &running, false, 3).is_none());
        card.finish(SubagentStatus::Completed, Some(4));
        let mut finished = running.to_vec();
        finished[1] = event(2, SessionEventBody::Subagent(card));
        let done = on_subagent(&working(), &finished, false, 4).unwrap();
        assert_eq!(done.state, AttentionState::Done);
        assert!(done.unread);
    }

    #[test]
    fn long_previews_are_cut() {
        let text = "字".repeat(PREVIEW_CHARS + 5);
        let cut = one_line(&text).unwrap();
        assert_eq!(cut.chars().count(), PREVIEW_CHARS + 1);
        assert!(cut.ends_with('…'));
        assert_eq!(one_line("  \n "), None);
    }
}
