//! 会话管理器：负责会话生命周期、事件日志、状态机与前端推送。
//!
//! Codex 会话的来源是官方 `thread/list`（与 `codex resume --all` 相同）。
//! 内存里只保存已经打开的进程句柄和事件日志。Claude 仍使用本地桩 id。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::agents::{adapter_for, AgentSession, EventSink, SessionContext};
use crate::codex_resume::{group_projects, sessions_for_project, CodexDirectory, CodexThread};
use crate::models::*;
use crate::project_store::ProjectStore;

struct SessionEntry {
    meta: Session,
    /// 完整事件日志（切换会话时通过 `get_session_events` 全量拉取）
    events: Vec<SessionEvent>,
    next_seq: u64,
    agent: Option<Arc<dyn AgentSession>>,
}

/// 前端事件名约定
pub const EVT_SESSION_EVENT: &str = "session-event";
pub const EVT_SESSIONS_CHANGED: &str = "sessions-changed";

pub struct SessionManager {
    entries: Arc<Mutex<HashMap<SessionId, SessionEntry>>>,
    app: AppHandle,
    codex: CodexDirectory,
    opening: tokio::sync::Mutex<()>,
}

impl SessionManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            app,
            codex: CodexDirectory::new(),
            opening: tokio::sync::Mutex::new(()),
        }
    }

    pub async fn projects_for_sidebar(&self, store: &ProjectStore) -> Vec<Project> {
        let threads = self.codex.list_threads().await.unwrap_or_default();
        group_projects(&store.list(), &threads)
    }

    pub async fn resolve_project(
        &self,
        store: &ProjectStore,
        id: &str,
    ) -> Result<Project, String> {
        if let Some(mut project) = store.get(id) {
            project.external = false;
            return Ok(project);
        }
        let threads = self.codex.list_threads().await?;
        group_projects(&store.list(), &threads)
            .into_iter()
            .find(|project| project.id == id)
            .ok_or_else(|| "项目不存在".to_string())
    }

    pub async fn sessions_for_sidebar(
        &self,
        store: &ProjectStore,
        project_id: &str,
    ) -> Vec<Session> {
        let project = match self.resolve_project(store, project_id).await {
            Ok(project) => project,
            Err(_) => return Vec::new(),
        };
        let threads = self.codex.list_threads().await.unwrap_or_default();
        let mut sessions = sessions_for_project(&project, &threads);
        let live = self.entries.lock().unwrap();
        for session in &mut sessions {
            if let Some(entry) = live.get(&session.id) {
                session.status = entry.meta.status;
                if session.title == "未命名会话" && !entry.meta.title.is_empty() {
                    session.title = entry.meta.title.clone();
                }
                session.updated_at = session.updated_at.max(entry.meta.updated_at);
            }
        }
        let known: HashSet<String> = sessions.iter().map(|session| session.id.clone()).collect();
        let mut extras: Vec<Session> = live
            .values()
            .filter(|entry| entry.meta.project_id == project.id && !known.contains(&entry.meta.id))
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
        let threads = self.codex.list_threads().await?;
        let thread = threads
            .iter()
            .find(|thread| thread.id == session_id)
            .cloned()
            .ok_or_else(|| "会话不存在".to_string())?;
        let project = group_projects(&store.list(), &threads)
            .into_iter()
            .find(|project| crate::codex_resume::cwd_key(&project.path) == thread.key)
            .ok_or_else(|| "找不到会话所在目录".to_string())?;
        self.attach(&project, &thread).await?;
        self.get_events(session_id)
    }

    async fn attach(&self, project: &Project, thread: &CodexThread) -> Result<(), String> {
        let (tx, rx) = mpsc::unbounded_channel::<SessionEventBody>();
        let ctx = SessionContext {
            session_id: thread.id.clone(),
            project_path: project.path.clone(),
            access_mode: None,
            resume_thread_id: Some(thread.id.clone()),
            persist_thread: true,
        };
        let handle = adapter_for(AgentKind::CodexCli)
            .start_session(ctx, tx)
            .await
            .map_err(|err| err.to_string())?;
        let meta = Session {
            id: thread.id.clone(),
            project_id: project.id.clone(),
            agent: AgentKind::CodexCli,
            title: thread.title.clone(),
            status: thread.status,
            created_at: thread.created_at,
            updated_at: thread.updated_at,
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
        let (tx, rx) = mpsc::unbounded_channel::<SessionEventBody>();
        let sink: EventSink = tx;
        let ctx = SessionContext {
            session_id: String::new(),
            project_path: project.path.clone(),
            access_mode,
            resume_thread_id: None,
            persist_thread: agent == AgentKind::CodexCli,
        };
        let handle = adapter_for(agent)
            .start_session(ctx, sink)
            .await
            .map_err(|err| err.to_string())?;
        let session_id = match handle.native_thread_id().filter(|id| !id.is_empty()) {
            Some(id) => id,
            None if agent == AgentKind::CodexCli => {
                let _ = handle.stop().await;
                return Err("Codex 没有返回可 resume 的 thread id，会话没有建立。".into());
            }
            None => new_id(),
        };
        let now = now_millis();
        let title = if agent == AgentKind::CodexCli {
            "未命名会话".to_string()
        } else {
            format!("会话 {}", self.local_count(&project.id) + 1)
        };
        let meta = Session {
            id: session_id.clone(),
            project_id: project.id.clone(),
            agent,
            title,
            status: SessionStatus::Running,
            created_at: now,
            updated_at: now,
        };
        self.install(meta, Some(handle), rx);
        self.codex.invalidate().await;
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
            },
        );
        while let Ok(body) = rx.try_recv() {
            apply_body(&self.entries, &self.app, &session_id, body);
        }
        let entries = Arc::clone(&self.entries);
        let app = self.app.clone();
        let sid = session_id;
        tauri::async_runtime::spawn(async move {
            while let Some(body) = rx.recv().await {
                apply_body(&entries, &app, &sid, body);
            }
        });
    }

    /// 追加本地产生的事件（用户消息 / 本地错误），并广播。
    fn record_local(&self, session_id: &str, body: SessionEventBody) -> Result<(), String> {
        if !self.entries.lock().unwrap().contains_key(session_id) {
            return Err("会话不存在".to_string());
        }
        apply_body(&self.entries, &self.app, session_id, body);
        Ok(())
    }

    fn agent_handle(&self, session_id: &str) -> Result<Arc<dyn AgentSession>, String> {
        self.entries
            .lock()
            .unwrap()
            .get(session_id)
            .and_then(|entry| entry.agent.clone())
            .ok_or_else(|| "会话不存在或已结束".to_string())
    }

    pub async fn send_message(&self, session_id: &str, text: String) -> Result<(), String> {
        let handle = self.agent_handle(session_id)?;
        self.record_local(session_id, SessionEventBody::UserMessage { text: text.clone() })?;
        handle.send_message(text).await.map_err(|err| err.to_string())
    }

    pub async fn answer_prompt(
        &self,
        session_id: &str,
        prompt_id: &str,
        answer: PromptAnswer,
    ) -> Result<(), String> {
        let handle = self.agent_handle(session_id)?;
        handle
            .answer_prompt(prompt_id, answer)
            .await
            .map_err(|err| err.to_string())
    }

    pub async fn agent_catalog(&self, session_id: &str) -> Result<AgentCatalog, String> {
        let handle = self.agent_handle(session_id)?;
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
        let handle = self.agent_handle(session_id)?;
        handle.stop().await.map_err(|err| err.to_string())
    }

    /// 移除项目时停止其全部已打开的会话（不删除 Codex 线程）。
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
) {
    let replaced = {
        let mut entries = entries.lock().unwrap();
        let Some(entry) = entries.get_mut(session_id) else {
            return;
        };
        replace_stream(entry, &body)
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
        let status_changed = matches!(body, SessionEventBody::StatusChanged { .. });
        if let SessionEventBody::StatusChanged { status } = &body {
            entry.meta.status = *status;
            entry.meta.updated_at = now_millis();
        }
        let mut title_changed = false;
        if let SessionEventBody::UserMessage { text } = &body {
            if entry.meta.title.starts_with("会话 ") || entry.meta.title == "未命名会话" {
                let first_line = text.lines().next().unwrap_or("");
                let title: String = first_line.chars().take(24).collect();
                if !title.is_empty() {
                    entry.meta.title = title;
                    entry.meta.updated_at = now_millis();
                    title_changed = true;
                }
            }
        }
        let event = SessionEvent {
            id: new_id(),
            session_id: session_id.to_string(),
            seq: entry.next_seq,
            ts: now_millis(),
            body,
        };
        entry.next_seq += 1;
        entry.events.push(event.clone());
        (
            event,
            entry.meta.project_id.clone(),
            status_changed || title_changed,
        )
    };
    let _ = app.emit(EVT_SESSION_EVENT, &event);
    if notify {
        let _ = app.emit(
            EVT_SESSIONS_CHANGED,
            serde_json::json!({ "project_id": project_id }),
        );
    }
}

/// 同一 `stream_id` 的助手消息或思考覆盖上一条，并沿用原来的事件 id。
fn replace_stream(entry: &mut SessionEntry, body: &SessionEventBody) -> Option<SessionEvent> {
    let (text, stream_id, thinking) = match body {
        SessionEventBody::AgentMessage {
            text,
            stream_id: Some(stream_id),
        } => (text, stream_id, false),
        SessionEventBody::Thinking {
            text,
            stream_id: Some(stream_id),
        } => (text, stream_id, true),
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
        SessionEventBody::AgentMessage { text: slot, .. }
        | SessionEventBody::Thinking { text: slot, .. } => *slot = text.clone(),
        _ => return None,
    }
    existing.ts = now_millis();
    entry.meta.updated_at = existing.ts;
    Some(existing.clone())
}
