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
    DirectoryEntry, EventSink, SessionContext, SessionDirectory, SourcedEntry, TurnDelivery,
    UserTurn,
};
use crate::features::projects::ProjectStore;
use crate::models::*;

use super::catalog::{
    catalog_with_ready_retry, soften_catalog, AgentCatalogRefresh, CachedAgentCatalog, CatalogCache,
};

struct SessionEntry {
    meta: Session,
    /// 完整事件日志（切换会话时通过 `get_session_events` 全量拉取）
    events: Vec<SessionEvent>,
    next_seq: u64,
    agent: Option<Arc<dyn AgentSession>>,
    /// 这次连接之后真正发生过对话才有值。打开、附着、状态变化不算。
    activity_at: Option<i64>,
    /// 作曲栏排队。不进时间线。
    queue: Vec<QueuedTurn>,
}

/// 前端事件名约定
pub const EVT_SESSION_EVENT: &str = "session-event";
pub const EVT_SESSIONS_CHANGED: &str = "sessions-changed";
pub const EVT_SESSION_QUEUE: &str = "session-queue";

pub struct SessionManager {
    entries: Arc<Mutex<HashMap<SessionId, SessionEntry>>>,
    app: AppHandle,
    directories: Vec<Arc<dyn SessionDirectory>>,
    opening: tokio::sync::Mutex<()>,
    catalog_cache: CatalogCache,
}

impl SessionManager {
    pub fn new(app: AppHandle, data_dir: &std::path::Path) -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            app,
            directories: session_directories(),
            opening: tokio::sync::Mutex::new(()),
            catalog_cache: CatalogCache::load(data_dir),
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
        archived: bool,
    ) -> Vec<Session> {
        let project = match self.resolve_project(store, project_id) {
            Ok(project) => project,
            Err(_) => return Vec::new(),
        };
        let (listed, _) = if archived {
            self.listed_archived().await
        } else {
            self.listed().await
        };
        let mut sessions = sessions_for_project(&project, &listed);
        let live = self.entries.lock().unwrap();
        for session in &mut sessions {
            if let Some(entry) = live.get(&session.id) {
                session.status = entry.meta.status;
                session.archived = entry.meta.archived;
                if session.title == "未命名会话" && !entry.meta.title.is_empty() {
                    session.title = entry.meta.title.clone();
                }
                // 目录 updatedAt 决定顺序。只有真实对话才并入本进程的活动时间。
                session.updated_at = sidebar_updated_at(session.updated_at, entry.activity_at);
            }
        }
        sessions.retain(|session| session.archived == archived);
        let mut extras: Vec<Session> = live
            .values()
            .filter(|entry| {
                entry.meta.project_id == project.id
                    && entry.meta.archived == archived
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
        let (archived, _) = self.listed_archived().await;
        let found = listed
            .iter()
            .chain(archived.iter())
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
            archived: entry.archived,
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
            archived: false,
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
                queue: Vec::new(),
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

    pub fn set_collaboration_mode(&self, session_id: &str, mode: &str) -> Result<(), String> {
        let handle = self.agent_handle(session_id)?;
        handle
            .set_collaboration_mode(mode)
            .map_err(|err| err.to_string())
    }

    pub async fn start_review(&self, session_id: &str, target: ReviewStart) -> Result<(), String> {
        let handle = self.agent_handle_ready(session_id).await?;
        if handle.read_only() {
            return Err(OCCUPIED_SESSION_NOTICE.to_string());
        }
        let label = target.label();
        self.record_local(
            session_id,
            SessionEventBody::UserMessage {
                text: label,
                images: Vec::new(),
            },
        )?;
        handle
            .start_review(target)
            .await
            .map_err(|err| err.to_string())
    }

    pub async fn review_targets(&self, session_id: &str) -> Result<ReviewTargets, String> {
        let handle = self.agent_handle_ready(session_id).await?;
        handle.review_targets().await.map_err(|err| err.to_string())
    }

    pub async fn load_older_history(&self, session_id: &str) -> Result<OlderHistory, String> {
        let handle = self.agent_handle_ready(session_id).await?;
        let (bodies, exhausted) = handle
            .load_older_history()
            .await
            .map_err(|err| err.to_string())?;
        let mut entries = self.entries.lock().unwrap();
        let Some(entry) = entries.get_mut(session_id) else {
            return Err("会话不存在".into());
        };
        let added = prepend_bodies(entry, session_id, bodies);
        Ok(OlderHistory {
            events: entry.events.clone(),
            added,
            exhausted,
        })
    }

    pub async fn revert_turn(&self, session_id: &str, turn_id: &str) -> Result<(), String> {
        let handle = self.agent_handle_ready(session_id).await?;
        handle
            .revert_turn(turn_id)
            .await
            .map_err(|err| err.to_string())
    }

    pub async fn send_message(
        &self,
        session_id: &str,
        text: String,
        images: Vec<String>,
    ) -> Result<(), String> {
        let handle = self.agent_handle_ready(session_id).await?;
        if handle.read_only() {
            return Err(OCCUPIED_SESSION_NOTICE.to_string());
        }
        if text.is_empty() && images.is_empty() {
            return Err("消息不能为空".into());
        }
        if text.starts_with('/') && images.is_empty() {
            self.record_local(
                session_id,
                SessionEventBody::UserMessage {
                    text: text.clone(),
                    images: Vec::new(),
                },
            )?;
            return handle
                .send_message(text)
                .await
                .map_err(|err| err.to_string());
        }
        let client_id = new_id();
        let delivery = handle
            .deliver(UserTurn {
                text: text.clone(),
                images: images.clone(),
                client_id,
            })
            .await
            .map_err(|err| err.to_string())?;
        if delivery == TurnDelivery::Started {
            self.record_local(session_id, SessionEventBody::UserMessage { text, images })?;
        }
        Ok(())
    }

    pub async fn update_queued_turn(
        &self,
        session_id: &str,
        queued_id: &str,
        text: String,
        images: Vec<String>,
    ) -> Result<(), String> {
        let handle = self.agent_handle_ready(session_id).await?;
        handle
            .update_queued(
                queued_id,
                UserTurn {
                    text,
                    images,
                    client_id: String::new(),
                },
            )
            .await
            .map_err(|err| err.to_string())
    }

    pub async fn remove_queued_turn(
        &self,
        session_id: &str,
        queued_id: &str,
    ) -> Result<(), String> {
        let handle = self.agent_handle_ready(session_id).await?;
        handle
            .remove_queued(queued_id)
            .await
            .map_err(|err| err.to_string())
    }

    pub fn session_queue(&self, session_id: &str) -> Vec<QueuedTurn> {
        self.entries
            .lock()
            .unwrap()
            .get(session_id)
            .map(|entry| entry.queue.clone())
            .unwrap_or_default()
    }

    pub async fn interrupt_turn(&self, session_id: &str) -> Result<(), String> {
        let handle = self.agent_handle_ready(session_id).await?;
        handle.interrupt().await.map_err(|err| err.to_string())
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

    pub fn cached_catalogs(&self) -> Vec<CachedAgentCatalog> {
        self.catalog_cache.list()
    }

    /// 向当前会话的适配器要目录。失败或空模型时保留该 Agent 上一次成功的结果。
    pub async fn agent_catalog(&self, session_id: &str) -> Result<AgentCatalogRefresh, String> {
        let handle = self.agent_handle_ready(session_id).await?;
        let kind = self
            .entries
            .lock()
            .unwrap()
            .get(session_id)
            .map(|entry| entry.meta.agent)
            .ok_or_else(|| "会话不存在或已结束".to_string())?;
        let previous = self.catalog_cache.get(kind);
        let incoming = handle.catalog().await.map_err(|err| err.to_string());
        let refresh = soften_catalog(previous.as_ref(), incoming)?;
        if refresh.notice.is_none() && !refresh.catalog.models.is_empty() {
            self.catalog_cache.remember(kind, &refresh.catalog);
        }
        Ok(refresh)
    }

    /// 侧边栏选中会话和目录请求会抢跑。句柄还没有时，等这次打开完成后再试一次。
    pub async fn agent_catalog_when_ready(
        &self,
        store: &ProjectStore,
        session_id: &str,
    ) -> Result<AgentCatalogRefresh, String> {
        catalog_with_ready_retry(
            || self.agent_catalog(session_id),
            || async { self.ensure_events(store, session_id).await.map(|_| ()) },
        )
        .await
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

    pub fn set_session_access(
        &self,
        session_id: &str,
        mode: &str,
        network_access: bool,
        writable_roots: Vec<String>,
        profile_id: String,
    ) -> Result<(), String> {
        let handle = self.agent_handle(session_id)?;
        handle
            .set_sandbox(mode, network_access, &writable_roots, &profile_id)
            .map_err(|err| err.to_string())
    }

    pub async fn permission_menu(
        &self,
        store: &crate::features::projects::ProjectStore,
        session_id: &str,
    ) -> Result<crate::models::PermissionMenu, String> {
        if self.lookup_agent(session_id).is_none() {
            self.ensure_events(store, session_id).await?;
        }
        let handle = self.agent_handle_ready(session_id).await?;
        handle
            .permission_menu()
            .await
            .map_err(|err| err.to_string())
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

    pub async fn reload_live_mcp(&self) -> Vec<String> {
        let handles: Vec<_> = self
            .entries
            .lock()
            .unwrap()
            .values()
            .filter_map(|entry| entry.agent.clone())
            .collect();
        let mut warnings = Vec::new();
        for handle in handles {
            if let Err(err) = handle.reload_mcp().await {
                warnings.push(err.to_string());
            }
        }
        warnings
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

    async fn listed_archived(&self) -> (Vec<SourcedEntry>, Vec<String>) {
        let mut listed = Vec::new();
        let mut errors = Vec::new();
        for directory in &self.directories {
            let agent = directory.kind();
            match directory.list_archived().await {
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

    async fn invalidate_kind(&self, agent: AgentKind) {
        for directory in &self.directories {
            if directory.kind() == agent {
                directory.invalidate().await;
            }
        }
    }

    fn emit_changed(&self, project_id: &str) {
        let _ = self.app.emit(
            EVT_SESSIONS_CHANGED,
            serde_json::json!({ "project_id": project_id }),
        );
    }

    /// 会话必须属于已注册项目：内存里打开的，或目录 cwd 对得上的。
    async fn locate_session(
        &self,
        store: &ProjectStore,
        session_id: &str,
    ) -> Result<(AgentKind, String, Project), String> {
        if let Some(entry) = self.entries.lock().unwrap().get(session_id) {
            let project = self.resolve_project(store, &entry.meta.project_id)?;
            return Ok((entry.meta.agent, entry.meta.native_id.clone(), project));
        }
        let (agent, native) =
            parse_session_key(session_id).ok_or_else(|| "会话不存在".to_string())?;
        let (active, _) = self.listed().await;
        let (archived, _) = self.listed_archived().await;
        let found = active
            .iter()
            .chain(archived.iter())
            .find(|item| item.agent == agent && item.entry.native_id == native);
        let Some(found) = found else {
            return Err("会话不存在".into());
        };
        let project = store
            .list()
            .into_iter()
            .find(|project| cwd_key(&project.path) == found.entry.cwd_key)
            .ok_or_else(|| "找不到会话所在目录".to_string())?;
        Ok((agent, native, project))
    }

    pub async fn rename_session(
        &self,
        store: &ProjectStore,
        session_id: &str,
        name: &str,
    ) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("无法保存更改。请重试".into());
        }
        let (agent, native, project) = self.locate_session(store, session_id).await?;
        let adapter = adapter_for(agent);
        if !adapter.capabilities().supports_rename {
            return Err(format!("{} 不支持重命名聊天", adapter.display_name()));
        }
        adapter
            .rename_thread(&native, name)
            .await
            .map_err(|err| err.to_string())?;
        if let Some(entry) = self.entries.lock().unwrap().get_mut(session_id) {
            entry.meta.title = name.to_string();
        }
        self.invalidate_kind(agent).await;
        self.emit_changed(&project.id);
        Ok(())
    }

    pub async fn set_session_archived(
        &self,
        store: &ProjectStore,
        session_id: &str,
        archived: bool,
    ) -> Result<(), String> {
        let (agent, native, project) = self.locate_session(store, session_id).await?;
        let adapter = adapter_for(agent);
        if !adapter.capabilities().supports_archive {
            return Err(format!("{} 不支持归档聊天", adapter.display_name()));
        }
        adapter
            .set_thread_archived(&native, archived)
            .await
            .map_err(|err| err.to_string())?;
        if let Some(entry) = self.entries.lock().unwrap().get_mut(session_id) {
            entry.meta.archived = archived;
        }
        self.invalidate_kind(agent).await;
        self.emit_changed(&project.id);
        Ok(())
    }

    pub async fn delete_session(
        &self,
        store: &ProjectStore,
        session_id: &str,
    ) -> Result<(), String> {
        let (agent, native, project) = self.locate_session(store, session_id).await?;
        let adapter = adapter_for(agent);
        if !adapter.capabilities().supports_delete {
            return Err(format!("{} 不支持永久删除", adapter.display_name()));
        }
        if let Err(first) = adapter.delete_thread(&native).await {
            let handle = self
                .entries
                .lock()
                .unwrap()
                .get(session_id)
                .and_then(|entry| entry.agent.clone());
            if let Some(handle) = handle {
                let _ = handle.stop().await;
            }
            adapter
                .delete_thread(&native)
                .await
                .map_err(|_| first.to_string())?;
        }
        self.entries.lock().unwrap().remove(session_id);
        self.invalidate_kind(agent).await;
        self.emit_changed(&project.id);
        Ok(())
    }

    pub async fn fork_session(
        &self,
        store: &ProjectStore,
        session_id: &str,
    ) -> Result<Session, String> {
        let (agent, native, project) = self.locate_session(store, session_id).await?;
        let adapter = adapter_for(agent);
        if !adapter.capabilities().supports_fork {
            return Err(format!("{} 不支持分叉聊天", adapter.display_name()));
        }
        let forked = adapter
            .fork_thread(&native)
            .await
            .map_err(|err| err.to_string())?;
        let session = Session {
            id: session_key(agent, &forked.native_id),
            project_id: project.id.clone(),
            agent,
            native_id: forked.native_id.clone(),
            title: forked.title.clone(),
            status: forked.status,
            created_at: forked.created_at,
            updated_at: forked.updated_at,
            archived: false,
        };
        // 父会话的 updated_at / activity_at 不动。打开分支走既有 resume。
        let _ = self.attach(&project, agent, &forked).await;
        self.invalidate_kind(agent).await;
        self.emit_changed(&project.id);
        Ok(session)
    }
}

fn parse_session_key(session_id: &str) -> Option<(AgentKind, String)> {
    let (kind, native) = session_id.split_once(':')?;
    if native.is_empty() {
        return None;
    }
    let agent = AgentKind::all()
        .into_iter()
        .find(|agent| agent.as_str() == kind)?;
    Some((agent, native.to_string()))
}

fn apply_body(
    entries: &Mutex<HashMap<SessionId, SessionEntry>>,
    app: &AppHandle,
    session_id: &str,
    body: SessionEventBody,
    record_activity: bool,
) {
    if let SessionEventBody::QueueChanged { items } = body {
        {
            let mut entries = entries.lock().unwrap();
            if let Some(entry) = entries.get_mut(session_id) {
                entry.queue = items.clone();
            }
        }
        let _ = app.emit(
            EVT_SESSION_QUEUE,
            serde_json::json!({ "session_id": session_id, "items": items }),
        );
        return;
    }
    if let SessionEventBody::Rewind { turn_id, .. } = &body {
        apply_rewind(entries, app, session_id, turn_id);
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
    if let SessionEventBody::UserMessage { text, images } = &body {
        if entry.meta.title.starts_with("会话 ") || entry.meta.title == "未命名会话" {
            let source = if text.trim().is_empty() && !images.is_empty() {
                "图片"
            } else {
                text.as_str()
            };
            let first_line = source.lines().next().unwrap_or("");
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
    )
}

/// 更早的回合插到日志前面。已有事件的 seq 整体上移，避免回退时把它们裁掉。
fn prepend_bodies(
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

/// 没有真实对话时沿用目录 updatedAt，即使内存里的时间被打开流程碰过。
fn sidebar_updated_at(directory_updated_at: i64, activity_at: Option<i64>) -> i64 {
    match activity_at {
        Some(activity) => directory_updated_at.max(activity),
        None => directory_updated_at,
    }
}

fn apply_rewind(
    entries: &Mutex<HashMap<SessionId, SessionEntry>>,
    app: &AppHandle,
    session_id: &str,
    turn_id: &str,
) {
    let event = {
        let mut entries = entries.lock().unwrap();
        let Some(entry) = entries.get_mut(session_id) else {
            return;
        };
        if let Some(drop_from) = truncate_from_turn(entry, turn_id) {
            SessionEvent {
                id: new_id(),
                session_id: session_id.to_string(),
                seq: drop_from,
                ts: now_millis(),
                body: SessionEventBody::Rewind {
                    turn_id: turn_id.to_string(),
                    drop_from_seq: drop_from,
                },
            }
        } else {
            mutate_entry(
                entry,
                session_id,
                SessionEventBody::Error {
                    message: "无法编辑消息".into(),
                },
                false,
            )
            .event
        }
    };
    let _ = app.emit(EVT_SESSION_EVENT, &event);
}

/// 从该回合的用户消息起截掉后面的时间线。不是最近一个回合时返回 None。
fn truncate_from_turn(entry: &mut SessionEntry, turn_id: &str) -> Option<u64> {
    let anchor = entry.events.iter().rposition(|event| {
        matches!(&event.body, SessionEventBody::TurnAnchor { turn_id: id } if id == turn_id)
    })?;
    let latest = entry
        .events
        .iter()
        .rposition(|event| matches!(event.body, SessionEventBody::TurnAnchor { .. }))?;
    if latest != anchor {
        return None;
    }
    let mut start = anchor;
    while start > 0 {
        if matches!(
            entry.events[start].body,
            SessionEventBody::UserMessage { .. }
        ) {
            break;
        }
        start -= 1;
    }
    if !matches!(
        entry.events[start].body,
        SessionEventBody::UserMessage { .. }
    ) {
        start = anchor;
    }
    let seq = entry.events[start].seq;
    entry.events.truncate(start);
    Some(seq)
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
                archived: false,
            },
            events: Vec::new(),
            next_seq: 1,
            agent: None,
            activity_at: None,
            queue: Vec::new(),
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
                images: Vec::new(),
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
                images: Vec::new(),
            },
            true,
        );
        let activity = session.activity_at.expect("live turn");
        assert!(activity >= 1_000);
        assert_eq!(session.meta.updated_at, activity);
        assert_eq!(session.meta.title, "概括当前项目");
        assert_eq!(sidebar_updated_at(1_000, session.activity_at), activity);
        assert_eq!(
            sidebar_updated_at(activity + 50, session.activity_at),
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
    fn revert_keeps_earlier_turns_and_refuses_an_older_one() {
        let mut session = entry(1_000);
        session.events = vec![
            stamped(
                1,
                SessionEventBody::UserMessage {
                    text: "keep".into(),
                    images: Vec::new(),
                },
            ),
            stamped(
                2,
                SessionEventBody::TurnAnchor {
                    turn_id: "old".into(),
                },
            ),
            stamped(
                3,
                SessionEventBody::AgentMessage {
                    text: "old".into(),
                    stream_id: None,
                    phase: None,
                },
            ),
            stamped(
                4,
                SessionEventBody::UserMessage {
                    text: "drop".into(),
                    images: Vec::new(),
                },
            ),
            stamped(
                5,
                SessionEventBody::TurnAnchor {
                    turn_id: "new".into(),
                },
            ),
            stamped(
                6,
                SessionEventBody::TurnDiff {
                    turn_id: "new".into(),
                    diff: "diff --git a/a b/a\n".into(),
                },
            ),
        ];
        assert!(truncate_from_turn(&mut session, "old").is_none());
        assert_eq!(session.events.len(), 6);
        assert_eq!(truncate_from_turn(&mut session, "new"), Some(4));
        assert_eq!(session.events.len(), 3);
        assert!(matches!(
            session.events.last().unwrap().body,
            SessionEventBody::AgentMessage { .. }
        ));
    }

    #[test]
    fn older_history_is_prepended_and_survives_rewind() {
        let mut session = entry(1_000);
        session.events = vec![
            stamped(
                1,
                SessionEventBody::UserMessage {
                    text: "new".into(),
                    images: Vec::new(),
                },
            ),
            stamped(
                2,
                SessionEventBody::TurnAnchor {
                    turn_id: "new".into(),
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
        assert_eq!(truncate_from_turn(&mut session, "new"), Some(3));
        assert_eq!(session.events.len(), 2);
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
