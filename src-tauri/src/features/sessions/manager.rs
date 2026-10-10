//! 会话管理器：负责会话生命周期、事件日志、状态机与前端推送。
//!
//! 项目列表只含工作台已注册的项目。某个项目下的会话，是各
//! `SessionDirectory` 里 cwd 匹配该项目的条目，再并上内存中已打开、
//! 尚未出现在目录里的会话。键是 agent kind + native id。管理器不依赖
//! 某一种 CLI 的目录类型。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::features::agents::{
    adapter_for, cwd_key, session_directories, session_key, sessions_for_project, AgentSession,
    DirectoryEntry, EventSink, SessionContext, SessionDirectory, SourcedEntry,
};
use crate::features::projects::ProjectStore;
use crate::models::*;

struct SessionEntry {
    meta: Session,
    /// 完整事件日志（切换会话时通过 `get_session_events` 全量拉取）
    events: Vec<SessionEvent>,
    next_seq: u64,
    agent: Option<Arc<dyn AgentSession>>,
    /// 这次连接之后真正发生过对话才有值。打开、附着、状态变化不算。
    activity_at: Option<i64>,
}

/// 前端事件名约定
pub const EVT_SESSION_EVENT: &str = "session-event";
pub const EVT_SESSIONS_CHANGED: &str = "sessions-changed";

pub struct SessionManager {
    entries: Arc<Mutex<HashMap<SessionId, SessionEntry>>>,
    app: AppHandle,
    directories: Vec<Arc<dyn SessionDirectory>>,
    opening: tokio::sync::Mutex<()>,
}

impl SessionManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            app,
            directories: session_directories(),
            opening: tokio::sync::Mutex::new(()),
        }
    }

    async fn listed(&self) -> (Vec<SourcedEntry>, Vec<String>) {
        let mut listed = Vec::new();
        let mut errors = Vec::new();
        for directory in &self.directories {
            let agent = directory.kind();
            match directory.list().await {
                Ok(entries) => {
                    for entry in entries {
                        listed.push(SourcedEntry { agent, entry });
                    }
                }
                Err(err) => errors.push(err),
            }
        }
        (listed, errors)
    }

    /// 只解析工作台已保存的项目。Agent 目录里的其它 cwd 不能当成项目打开。
    pub fn resolve_project(&self, store: &ProjectStore, id: &str) -> Result<Project, String> {
        let mut project = store.get(id).ok_or_else(|| "项目不存在".to_string())?;
        project.external = false;
        Ok(project)
    }

    pub async fn sessions_for_sidebar(
        &self,
        store: &ProjectStore,
        project_id: &str,
    ) -> Vec<Session> {
        let project = match self.resolve_project(store, project_id) {
            Ok(project) => project,
            Err(_) => return Vec::new(),
        };
        let (listed, _) = self.listed().await;
        let mut sessions = sessions_for_project(&project, &listed);
        let live = self.entries.lock().unwrap();
        for session in &mut sessions {
            if let Some(entry) = live.get(&session.id) {
                session.status = entry.meta.status;
                if session.title == "未命名会话" && !entry.meta.title.is_empty() {
                    session.title = entry.meta.title.clone();
                }
                // 目录 updatedAt 决定顺序。只有真实对话才并入本进程的活动时间。
                session.updated_at = sidebar_updated_at(session.updated_at, entry.activity_at);
            }
        }
        let mut extras: Vec<Session> = live
            .values()
            .filter(|entry| {
                entry.meta.project_id == project.id
                    && !sessions.iter().any(|session| {
                        session.agent == entry.meta.agent
                            && session.native_id == entry.meta.native_id
                    })
            })
            .map(|entry| entry.meta.clone())
            .collect();
        drop(live);
        sessions.append(&mut extras);
        sessions.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| b.created_at.cmp(&a.created_at))
        });
        sessions
    }

    pub fn get_events(&self, session_id: &str) -> Result<Vec<SessionEvent>, String> {
        let entries = self.entries.lock().unwrap();
        entries
            .get(session_id)
            .map(|entry| entry.events.clone())
            .ok_or_else(|| "会话不存在".to_string())
    }

    /// 打开侧边栏里的 Codex 线程：已连接则直接返回日志，否则 `thread/resume`。
    pub async fn ensure_events(
        &self,
        store: &ProjectStore,
        session_id: &str,
    ) -> Result<Vec<SessionEvent>, String> {
        if self.entries.lock().unwrap().contains_key(session_id) {
            return self.get_events(session_id);
        }
        let _guard = self.opening.lock().await;
        if self.entries.lock().unwrap().contains_key(session_id) {
            return self.get_events(session_id);
        }
        let (listed, errors) = self.listed().await;
        let found = listed
            .iter()
            .find(|item| session_key(item.agent, &item.entry.native_id) == session_id)
            .cloned();
        let Some(found) = found else {
            return Err(errors
                .into_iter()
                .next()
                .unwrap_or_else(|| "会话不存在".to_string()));
        };
        let project = store
            .list()
            .into_iter()
            .find(|project| cwd_key(&project.path) == found.entry.cwd_key)
            .ok_or_else(|| "找不到会话所在目录".to_string())?;
        self.attach(&project, found.agent, &found.entry).await?;
        self.get_events(session_id)
    }

    async fn attach(
        &self,
        project: &Project,
        agent: AgentKind,
        entry: &DirectoryEntry,
    ) -> Result<(), String> {
        let (tx, rx) = mpsc::unbounded_channel::<SessionEventBody>();
        let session_id = session_key(agent, &entry.native_id);
        let ctx = SessionContext {
            project_path: project.path.clone(),
            access_mode: None,
            resume_native_id: Some(entry.native_id.clone()),
            options: serde_json::json!({ "persist": true }),
        };
        let handle = adapter_for(agent)
            .start_session(ctx, tx)
            .await
            .map_err(|err| err.to_string())?;
        let meta = Session {
            id: session_id,
            project_id: project.id.clone(),
            agent,
            native_id: entry.native_id.clone(),
            title: entry.title.clone(),
            status: entry.status,
            created_at: entry.created_at,
            updated_at: entry.updated_at,
        };
        self.install(meta, Some(handle), rx);
        Ok(())
    }

    /// 启动新会话。Codex 使用 `thread/start` 返回的 thread id，不再另造 UUID。
    pub async fn create_session(
        &self,
        project: &Project,
        agent: AgentKind,
        access_mode: Option<String>,
    ) -> Result<Session, String> {
        let adapter = adapter_for(agent);
        let caps = adapter.capabilities();
        let (tx, rx) = mpsc::unbounded_channel::<SessionEventBody>();
        let sink: EventSink = tx;
        let ctx = SessionContext {
            project_path: project.path.clone(),
            access_mode,
            resume_native_id: None,
            options: serde_json::json!({ "persist": caps.supports_resume }),
        };
        let handle = adapter
            .start_session(ctx, sink)
            .await
            .map_err(|err| err.to_string())?;
        let session_id = match handle.native_id().filter(|id| !id.is_empty()) {
            Some(id) => session_key(agent, &id),
            None if caps.supports_resume => {
                let _ = handle.stop().await;
                return Err(format!(
                    "{} 没有返回可 resume 的会话 id，会话没有建立。",
                    agent.display_name()
                ));
            }
            None => session_key(agent, &new_id()),
        };
        let native_id = session_id
            .split_once(':')
            .map(|(_, native)| native.to_string())
            .unwrap_or_else(|| session_id.clone());
        let now = now_millis();
        let title = if caps.supports_resume {
            "未命名会话".to_string()
        } else {
            format!("会话 {}", self.local_count(&project.id) + 1)
        };
        let meta = Session {
            id: session_id.clone(),
            project_id: project.id.clone(),
            agent,
            native_id,
            title,
            status: SessionStatus::Running,
            created_at: now,
            updated_at: now,
        };
        self.install(meta, Some(handle), rx);
        for directory in &self.directories {
            if directory.kind() == agent {
                directory.invalidate().await;
            }
        }
        self.entries
            .lock()
            .unwrap()
            .get(&session_id)
            .map(|entry| entry.meta.clone())
            .ok_or_else(|| "会话没有建立".to_string())
    }

    fn local_count(&self, project_id: &str) -> usize {
        self.entries
            .lock()
            .unwrap()
            .values()
            .filter(|entry| entry.meta.project_id == project_id)
            .count()
    }

    fn install(
        &self,
        meta: Session,
        handle: Option<Arc<dyn AgentSession>>,
        mut rx: mpsc::UnboundedReceiver<SessionEventBody>,
    ) {
        let session_id = meta.id.clone();
        self.entries.lock().unwrap().insert(
            session_id.clone(),
            SessionEntry {
                meta,
                events: Vec::new(),
                next_seq: 1,
                agent: handle,
                activity_at: None,
            },
        );
        // start_session 返回前已经把历史、连接说明和状态放进通道。
        // 这些是打开/附着，不能改侧边栏排序时间。
        while let Ok(body) = rx.try_recv() {
            apply_body(&self.entries, &self.app, &session_id, body, false);
        }
        let entries = Arc::clone(&self.entries);
        let app = self.app.clone();
        let sid = session_id;
        tauri::async_runtime::spawn(async move {
            while let Some(body) = rx.recv().await {
                apply_body(&entries, &app, &sid, body, true);
            }
        });
    }

    /// 追加本地产生的事件（用户消息 / 本地错误），并广播。
    fn record_local(&self, session_id: &str, body: SessionEventBody) -> Result<(), String> {
        if !self.entries.lock().unwrap().contains_key(session_id) {
            return Err("会话不存在".to_string());
        }
        apply_body(&self.entries, &self.app, session_id, body, true);
        Ok(())
    }

    fn lookup_agent(&self, session_id: &str) -> Option<Arc<dyn AgentSession>> {
        self.entries
            .lock()
            .unwrap()
            .get(session_id)
            .and_then(|entry| entry.agent.clone())
    }

    fn agent_handle(&self, session_id: &str) -> Result<Arc<dyn AgentSession>, String> {
        self.lookup_agent(session_id)
            .ok_or_else(|| "会话不存在或已结束".to_string())
    }

    /// 侧边栏会先选中会话，而 `thread/resume` 还在进行。
    /// 等这次打开结束再取句柄，避免把「正在打开」说成会话不存在。
    async fn agent_handle_ready(&self, session_id: &str) -> Result<Arc<dyn AgentSession>, String> {
        if let Some(handle) = self.lookup_agent(session_id) {
            return Ok(handle);
        }
        let _guard = self.opening.lock().await;
        self.agent_handle(session_id)
    }

    pub async fn send_message(&self, session_id: &str, text: String) -> Result<(), String> {
        let handle = self.agent_handle_ready(session_id).await?;
        if handle.read_only() {
            return Err(OCCUPIED_SESSION_NOTICE.to_string());
        }
        self.record_local(session_id, SessionEventBody::UserMessage { text: text.clone() })?;
        handle.send_message(text).await.map_err(|err| err.to_string())
    }

    pub async fn answer_prompt(
        &self,
        session_id: &str,
        prompt_id: &str,
        answer: PromptAnswer,
    ) -> Result<(), String> {
        let handle = self.agent_handle_ready(session_id).await?;
        if handle.read_only() {
            return Err(OCCUPIED_SESSION_NOTICE.to_string());
        }
        handle
            .answer_prompt(prompt_id, answer)
            .await
            .map_err(|err| err.to_string())
    }

    pub async fn agent_catalog(&self, session_id: &str) -> Result<AgentCatalog, String> {
        let handle = self.agent_handle_ready(session_id).await?;
        handle.catalog().await.map_err(|err| err.to_string())
    }

    pub fn set_session_tuning(
        &self,
        session_id: &str,
        model: Option<String>,
        effort: Option<String>,
    ) -> Result<(), String> {
        let handle = self.agent_handle(session_id)?;
        handle
            .set_tuning(model, effort)
            .map_err(|err| err.to_string())
    }

    pub fn set_session_access(&self, session_id: &str, mode: &str) -> Result<(), String> {
        let handle = self.agent_handle(session_id)?;
        handle.set_access_mode(mode).map_err(|err| err.to_string())
    }

    pub fn set_session_agent(&self, session_id: &str, agent: AgentKind) -> Result<(), String> {
        let (handle, project_id) = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries
                .get_mut(session_id)
                .ok_or_else(|| "会话不存在".to_string())?;
            entry.meta.agent = agent;
            entry.meta.updated_at = now_millis();
            (entry.agent.clone(), entry.meta.project_id.clone())
        };
        if let Some(handle) = handle {
            handle.retarget(agent);
        }
        let _ = self.app.emit(
            EVT_SESSIONS_CHANGED,
            serde_json::json!({ "project_id": project_id }),
        );
        Ok(())
    }

    pub async fn stop_session(&self, session_id: &str) -> Result<(), String> {
        let handle = self.agent_handle_ready(session_id).await?;
        handle.stop().await.map_err(|err| err.to_string())
    }

    /// 移除项目时停掉本进程里已打开的会话。
    /// 只结束进程内连接，不删除 Agent 的 rollout，也不改写 Agent 自己的项目列表。
    pub async fn stop_sessions_of_project(&self, project_id: &str) {
        let ids: Vec<String> = {
            let entries = self.entries.lock().unwrap();
            entries
                .values()
                .filter(|entry| entry.meta.project_id == project_id)
                .map(|entry| entry.meta.id.clone())
                .collect()
        };
        for id in ids {
            if let Ok(handle) = self.agent_handle(&id) {
                let _ = handle.stop().await;
            }
            self.entries.lock().unwrap().remove(&id);
        }
        let _ = self.app.emit(
            EVT_SESSIONS_CHANGED,
            serde_json::json!({ "project_id": project_id }),
        );
    }
}

fn apply_body(
    entries: &Mutex<HashMap<SessionId, SessionEntry>>,
    app: &AppHandle,
    session_id: &str,
    body: SessionEventBody,
    record_activity: bool,
) {
    let replaced = {
        let mut entries = entries.lock().unwrap();
        let Some(entry) = entries.get_mut(session_id) else {
            return;
        };
        replace_stream(entry, &body, record_activity)
    };
    if let Some(event) = replaced {
        let _ = app.emit(EVT_SESSION_EVENT, &event);
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
    let _ = app.emit(EVT_SESSION_EVENT, &event);
    if notify {
        let _ = app.emit(
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
    if let SessionEventBody::UserMessage { text } = &body {
        if entry.meta.title.starts_with("会话 ") || entry.meta.title == "未命名会话" {
            let first_line = text.lines().next().unwrap_or("");
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
    )
}

fn note_activity(entry: &mut SessionEntry, at: i64) {
    entry.activity_at = Some(at);
    entry.meta.updated_at = at;
}

/// 没有真实对话时沿用目录 updatedAt，即使内存里的时间被打开流程碰过。
fn sidebar_updated_at(directory_updated_at: i64, activity_at: Option<i64>) -> i64 {
    match activity_at {
        Some(activity) => directory_updated_at.max(activity),
        None => directory_updated_at,
    }
}

/// 同一 `stream_id` 的助手消息或思考覆盖上一条，并沿用原来的事件 id。
fn replace_stream(
    entry: &mut SessionEntry,
    body: &SessionEventBody,
    record_activity: bool,
) -> Option<SessionEvent> {
    let (text, stream_id, thinking, phase) = match body {
        SessionEventBody::AgentMessage {
            text,
            stream_id: Some(stream_id),
            phase,
        } => (text, stream_id, false, *phase),
        SessionEventBody::Thinking {
            text,
            stream_id: Some(stream_id),
        } => (text, stream_id, true, None),
        _ => return None,
    };
    let existing = entry.events.iter_mut().rev().find(|event| match &event.body {
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
            ..
        } if !thinking => {
            *slot = text.clone();
            if let Some(phase) = phase {
                *slot_phase = Some(phase);
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
            },
            events: Vec::new(),
            next_seq: 1,
            agent: None,
            activity_at: None,
        }
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
        assert_eq!(sidebar_updated_at(1_000, session.activity_at), 1_000);
        session.meta.updated_at = 9_999_999;
        assert_eq!(sidebar_updated_at(1_000, session.activity_at), 1_000);
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
            },
            true,
        );
        let activity = session.activity_at.expect("live turn");
        assert!(activity >= 1_000);
        assert_eq!(session.meta.updated_at, activity);
        assert_eq!(session.meta.title, "概括当前项目");
        assert_eq!(sidebar_updated_at(1_000, session.activity_at), activity);
        assert_eq!(sidebar_updated_at(activity + 50, session.activity_at), activity + 50);
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
            },
            false,
        );
        assert_eq!(session.meta.title, "概括当前项目");
        assert_eq!(session.activity_at, None);
        assert_eq!(session.meta.updated_at, 1_000);
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
            },
            false,
        );
        assert!(replace_stream(
            &mut session,
            &SessionEventBody::AgentMessage {
                text: "先看目录".into(),
                stream_id: Some("s1".into()),
                phase: None,
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
            },
            true,
        )
        .is_some());
        assert_eq!(session.activity_at, Some(session.meta.updated_at));
        assert!(session.meta.updated_at >= 1_000);
        match &session.events[0].body {
            SessionEventBody::AgentMessage { text, phase, .. } => {
                assert_eq!(text, "先看目录结构");
                assert_eq!(phase, &Some(crate::models::MessagePhase::Commentary));
            }
            other => panic!("expected streamed agent message, got {other:?}"),
        }
    }
}
