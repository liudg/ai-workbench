//! 跨 Agent 交接的运行时部分：换 Agent 时记一条待交接，第一条消息发出时把前文拼进去。
//!
//! 一个任务的会话按先后接成一条时间线。新线程（没有原生 id）拿到前面全部的对话；
//! 接回这个 Agent 原来的线程时，只补它离开之后别的 Agent 做的那段。
//! 照 t3code `apps/server/src/orchestration-v2/Orchestrator.ts` 里 provider switch 的
//! `full_thread_summary` / `delta_since_target_last_seen`。

use aiwb_core::handoff::{budget, coverage, historical_message, message_with_handoff, select_history, DEFAULT_TOKEN_CAP};
use aiwb_core::models::{AgentKind, HandoffStrategy, SessionEvent, SessionEventBody, SessionStatus};
use aiwb_core::task::TaskSession;

use super::{RuntimeResult, Runtimes};

/// 这次要交的前文。
pub(crate) struct PreparedHandoff {
    event_id: String,
    body: SessionEventBody,
    strategy: HandoffStrategy,
    history: Option<String>,
    selected: u32,
    omitted: u32,
}

impl PreparedHandoff {
    /// 发给 Agent 的文字。没有可交的前文时就是用户写的那句。
    pub(crate) fn message(&self, user_text: &str) -> String {
        match &self.history {
            Some(history) => message_with_handoff(self.strategy, history, user_text),
            None => user_text.to_string(),
        }
    }
}

impl Runtimes {
    /// 记一条待交接。换 Agent 和分叉时调用。
    pub(crate) fn record_handoff(
        &self,
        session_id: &str,
        from: &TaskSession,
        to: &TaskSession,
        strategy: HandoffStrategy,
    ) -> RuntimeResult<()> {
        self.record(
            session_id,
            SessionEventBody::Handoff {
                from_agent: from.agent,
                from_model: from.options.model.clone(),
                to_agent: to.agent,
                to_model: to.options.model.clone(),
                strategy,
                delivered: false,
                selected: 0,
                omitted: 0,
            },
        )
    }

    /// 分叉：把来源任务的时间线照原样（连同时间）抄进新会话。
    /// 没交出去的待交接不抄；用量是原任务花的，也不抄。
    pub(crate) fn copy_events(&self, session_id: &str, events: Vec<SessionEvent>) -> RuntimeResult<()> {
        for event in events {
            let skip = matches!(
                event.body,
                SessionEventBody::StatusChanged { .. }
                    | SessionEventBody::QueueChanged { .. }
                    | SessionEventBody::NewThread { .. }
                    | SessionEventBody::ContextUsage { .. }
                    | SessionEventBody::SessionUsage { .. }
                    | SessionEventBody::Handoff { delivered: false, .. }
            );
            if !skip {
                self.append_at(session_id, event.body, false, event.ts)?;
            }
        }
        Ok(())
    }

    /// 这个会话还有没交出去的前文时，按预算挑好。回合进行中发的消息会排队，那时不交。
    pub(crate) fn prepare_handoff(
        &self,
        session_id: &str,
        user_text: &str,
        images: usize,
    ) -> RuntimeResult<Option<PreparedHandoff>> {
        let store_err = |e: aiwb_store::StoreError| e.to_string();
        let target = self
            .store
            .session(session_id)
            .map_err(store_err)?
            .ok_or_else(|| "会话不存在".to_string())?;
        if matches!(target.status, SessionStatus::Starting | SessionStatus::Running | SessionStatus::NeedsInput) {
            return Ok(None);
        }
        let own = self.store.events_since(session_id, 0).map_err(store_err)?;
        let Some(position) = own.iter().rposition(|stored| {
            matches!(stored.event.body, SessionEventBody::Handoff { delivered: false, .. })
        }) else {
            return Ok(None);
        };
        let pending = own[position].event.clone();
        let SessionEventBody::Handoff {
            from_agent, strategy, ..
        } = &pending.body
        else {
            unreachable!("只挑了待交接");
        };

        let sessions = self.store.task_sessions(&target.task_id).map_err(store_err)?;
        let index = sessions
            .iter()
            .position(|session| session.id == target.id)
            .ok_or_else(|| "会话不在任务里".to_string())?;
        let earlier = &sessions[..index];
        // 接回原线程时，从这个 Agent 上次离开的那段之后算起。找不到原线程就当新线程。
        let resumed_from = target.native_id.as_ref().and_then(|native| {
            earlier
                .iter()
                .rposition(|session| session.agent == target.agent && session.native_id.as_ref() == Some(native))
        });
        let strategy = match resumed_from {
            Some(_) if *strategy == HandoffStrategy::Delta => HandoffStrategy::Delta,
            _ => HandoffStrategy::Full,
        };
        let covered_sessions = match (strategy, resumed_from) {
            (HandoffStrategy::Delta, Some(source)) => &earlier[source + 1..],
            _ => earlier,
        };
        let mut covered: Vec<SessionEvent> = Vec::new();
        for session in covered_sessions {
            let events = self.store.events_since(&session.id, 0).map_err(store_err)?;
            covered.extend(events.into_iter().map(|stored| stored.event));
        }
        covered.extend(own[..position].iter().map(|stored| stored.event.clone()));

        let mut from: Vec<AgentKind> = Vec::new();
        for agent in covered_sessions.iter().map(|session| session.agent).chain([*from_agent]) {
            if !from.contains(&agent) {
                from.push(agent);
            }
        }
        let usage = resumed_from
            .filter(|_| strategy == HandoffStrategy::Delta)
            .map(|source| self.native_usage(&earlier[source]))
            .transpose()?
            .flatten();
        let messages: Vec<_> = covered.iter().filter_map(historical_message).collect();
        let total = messages.len();
        let room = budget(DEFAULT_TOKEN_CAP, user_text, images, usage);
        let selection = select_history(messages, &coverage(&from, target.agent), room);
        let selected = selection.messages.len() as u32;
        Ok(Some(PreparedHandoff {
            event_id: pending.id,
            body: pending.body,
            strategy,
            history: (total > 0 && selected > 0).then(|| selection.render()),
            selected,
            omitted: selection.omitted as u32,
        }))
    }

    /// 发出去了：记下交了几条、省了几条。
    pub(crate) fn mark_delivered(&self, session_id: &str, handoff: PreparedHandoff) -> RuntimeResult<()> {
        let SessionEventBody::Handoff {
            from_agent,
            from_model,
            to_agent,
            to_model,
            ..
        } = handoff.body
        else {
            return Ok(());
        };
        self.rewrite(
            session_id,
            &handoff.event_id,
            SessionEventBody::Handoff {
                from_agent,
                from_model,
                to_agent,
                to_model,
                strategy: handoff.strategy,
                delivered: true,
                selected: handoff.selected,
                omitted: handoff.omitted,
            },
        )
    }

    /// 原线程上次报的上下文用量（已用，窗口）。
    fn native_usage(&self, session: &TaskSession) -> RuntimeResult<Option<(i64, Option<i64>)>> {
        let events = self.store.events_since(&session.id, 0).map_err(|e| e.to_string())?;
        Ok(events.iter().rev().find_map(|stored| match &stored.event.body {
            SessionEventBody::ContextUsage {
                used_tokens: Some(used),
                max_tokens,
                ..
            } => Some((*used, *max_tokens)),
            _ => None,
        }))
    }
}
