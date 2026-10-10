//! 会话管理器：负责会话生命周期、事件日志、状态机与前端推送。
//!
//! 数据流：
//!   适配器 ──SessionEventBody──► 转发任务（本模块）──► 事件日志 + `session-event` 广播
//!   前端 ──invoke commands──► 本模块 ──► 适配器句柄
//!
//! 会话元信息常驻内存（v1 不做会话持久化，重启后会话列表清空——
//! 项目列表由 ProjectStore 持久化）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::agents::{adapter_for, AgentSession, EventSink, SessionContext};
use crate::models::*;

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
}

impl SessionManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            app,
        }
    }

    pub fn list_sessions(&self, project_id: &str) -> Vec<Session> {
        let entries = self.entries.lock().unwrap();
        let mut list: Vec<Session> = entries
            .values()
            .filter(|e| e.meta.project_id == project_id)
            .map(|e| e.meta.clone())
            .collect();
        list.sort_by_key(|s| s.created_at);
        list
    }

    pub fn get_events(&self, session_id: &str) -> Result<Vec<SessionEvent>, String> {
        let entries = self.entries.lock().unwrap();
        entries
            .get(session_id)
            .map(|e| e.events.clone())
            .ok_or_else(|| "会话不存在".to_string())
    }

    /// 启动新会话：建立事件通道 → 注册条目 → 启动转发任务 → 交给适配器。
    pub async fn create_session(
        &self,
        project: &Project,
        agent: AgentKind,
        access_mode: Option<String>,
    ) -> Result<Session, String> {
        let session_id = new_id();
        let now = now_millis();
        let ordinal = self.list_sessions(&project.id).len() + 1;
        let meta = Session {
            id: session_id.clone(),
            project_id: project.id.clone(),
            agent,
            title: format!("会话 {ordinal}"),
            status: SessionStatus::Running,
            created_at: now,
            updated_at: now,
        };

        let (tx, mut rx) = mpsc::unbounded_channel::<SessionEventBody>();
        let sink: EventSink = tx;

        self.entries.lock().unwrap().insert(
            session_id.clone(),
            SessionEntry {
                meta: meta.clone(),
                events: Vec::new(),
                next_seq: 1,
                agent: None,
            },
        );

        // 转发任务：事件编号 → 落日志 → 推给前端；StatusChanged 时同步元信息
        let entries = Arc::clone(&self.entries);
        let app = self.app.clone();
        let sid = session_id.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(body) = rx.recv().await {
                let replaced = {
                    let mut entries = entries.lock().unwrap();
                    let Some(entry) = entries.get_mut(&sid) else { break };
                    replace_stream(entry, &body)
                };
                if let Some(event) = replaced {
                    let _ = app.emit(EVT_SESSION_EVENT, &event);
                    continue;
                }

                let mut entries = entries.lock().unwrap();
                let Some(entry) = entries.get_mut(&sid) else { break };
                let status_changed = match &body {
                    SessionEventBody::StatusChanged { status } => Some(*status),
                    _ => None,
                };
                if let Some(status) = status_changed {
                    entry.meta.status = status;
                    entry.meta.updated_at = now_millis();
                }
                let event = SessionEvent {
                    id: new_id(),
                    session_id: sid.clone(),
                    seq: entry.next_seq,
                    ts: now_millis(),
                    body,
                };
                entry.next_seq += 1;
                entry.events.push(event.clone());
                let project_id = entry.meta.project_id.clone();
                drop(entries);

                let _ = app.emit(EVT_SESSION_EVENT, &event);
                if status_changed.is_some() {
                    let _ = app.emit(
                        EVT_SESSIONS_CHANGED,
                        serde_json::json!({ "project_id": project_id }),
                    );
                }
            }
        });

        // 交给适配器启动会话（Codex 为真实进程，Claude 仍是桩）
        let ctx = SessionContext {
            session_id: session_id.clone(),
            project_path: project.path.clone(),
            access_mode,
        };
        match adapter_for(agent).start_session(ctx, sink).await {
            Ok(handle) => {
                if let Some(entry) = self.entries.lock().unwrap().get_mut(&session_id) {
                    entry.agent = Some(handle);
                }
                Ok(meta)
            }
            Err(e) => {
                self.entries.lock().unwrap().remove(&session_id);
                Err(e.to_string())
            }
        }
    }

    /// 追加本地产生的事件（用户消息 / 本地错误），并广播。
    fn record_local(&self, session_id: &str, body: SessionEventBody) -> Result<(), String> {
        let payload = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries
                .get_mut(session_id)
                .ok_or_else(|| "会话不存在".to_string())?;

            // 首条用户消息用作会话标题
            if let SessionEventBody::UserMessage { text } = &body {
                if entry.meta.title.starts_with("会话 ") {
                    let first_line = text.lines().next().unwrap_or("");
                    let title: String = first_line.chars().take(24).collect();
                    if !title.is_empty() {
                        entry.meta.title = title;
                    }
                }
            }
            entry.meta.updated_at = now_millis();
            let event = SessionEvent {
                id: new_id(),
                session_id: session_id.to_string(),
                seq: entry.next_seq,
                ts: now_millis(),
                body,
            };
            entry.next_seq += 1;
            entry.events.push(event.clone());
            (event, entry.meta.project_id.clone())
        };
        {
            let (event, project_id) = payload;
            let _ = self.app.emit(EVT_SESSION_EVENT, &event);
            let _ = self.app.emit(
                EVT_SESSIONS_CHANGED,
                serde_json::json!({ "project_id": project_id }),
            );
        }
        Ok(())
    }

    fn agent_handle(&self, session_id: &str) -> Result<Arc<dyn AgentSession>, String> {
        self.entries
            .lock()
            .unwrap()
            .get(session_id)
            .and_then(|e| e.agent.clone())
            .ok_or_else(|| "会话不存在或已结束".to_string())
    }

    pub async fn send_message(&self, session_id: &str, text: String) -> Result<(), String> {
        let handle = self.agent_handle(session_id)?;
        self.record_local(session_id, SessionEventBody::UserMessage { text: text.clone() })?;
        handle
            .send_message(text)
            .await
            .map_err(|e| e.to_string())
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
            .map_err(|e| e.to_string())
    }

    /// 更新会话当前 Agent。桩会话只影响后续文案；不重写已有时间线。
    pub async fn agent_catalog(&self, session_id: &str) -> Result<AgentCatalog, String> {
        let handle = self.agent_handle(session_id)?;
        handle.catalog().await.map_err(|e| e.to_string())
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
            .map_err(|e| e.to_string())
    }

    pub fn set_session_access(&self, session_id: &str, mode: &str) -> Result<(), String> {
        let handle = self.agent_handle(session_id)?;
        handle
            .set_access_mode(mode)
            .map_err(|e| e.to_string())
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
        handle.stop().await.map_err(|e| e.to_string())
    }

    /// 移除项目时停止其全部会话（进程不 orphaned）。
    pub async fn stop_sessions_of_project(&self, project_id: &str) {
        let ids: Vec<String> = {
            let entries = self.entries.lock().unwrap();
            entries
                .values()
                .filter(|e| e.meta.project_id == project_id)
                .map(|e| e.meta.id.clone())
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

/// 同一 `stream_id` 的助手消息覆盖上一条，并沿用原来的事件 id。
fn replace_stream(entry: &mut SessionEntry, body: &SessionEventBody) -> Option<SessionEvent> {
    let SessionEventBody::AgentMessage {
        text,
        stream_id: Some(stream_id),
    } = body
    else {
        return None;
    };
    let existing = entry.events.iter_mut().rev().find(|event| {
        matches!(
            &event.body,
            SessionEventBody::AgentMessage {
                stream_id: Some(id),
                ..
            } if id == stream_id
        )
    })?;
    if let SessionEventBody::AgentMessage { text: slot, .. } = &mut existing.body {
        *slot = text.clone();
    }
    existing.ts = now_millis();
    entry.meta.updated_at = existing.ts;
    Some(existing.clone())
}
