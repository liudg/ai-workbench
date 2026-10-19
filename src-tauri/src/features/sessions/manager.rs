//! 会话管理器：负责会话生命周期和前端推送。
//! 事件日志的归并在 `log`。
//!
//! 项目列表只含工作台已注册的项目。某个项目下的会话，是各
//! `SessionDirectory` 里 cwd 匹配该项目的条目，再并上内存中已打开、
//! 尚未出现在目录里的会话。键是 agent kind + native id。管理器不依赖
//! 某一种 CLI 的目录类型。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use crate::features::agents::{
    adapter_for, project_matches_cwd, session_directories, session_key, sessions_for_project,
    AgentSession, DiffScope, DirectoryEntry, EventSink, PreparedWorktree, SessionContext,
    SessionDirectory, SourcedEntry, TurnDelivery, UserTurn,
};
use crate::features::git::{self, Checkout};
use crate::features::projects::ProjectStore;
use crate::models::*;

use super::catalog::{
    after_list_refresh, catalog_with_ready_retry, command_when_ready, soften_catalog,
    AgentCatalogRefresh, CatalogCache,
};
pub use super::log::EventEmitter;
use super::log::{
    apply_body, prepend_bodies, sidebar_updated_at, SessionEntry, EVT_SESSIONS_CHANGED,
};
use super::permission_cache::PermissionMenuCache;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAndSendResult {
    pub session: Session,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_error: Option<String>,
    /// 独立聊天首发时新建的隐藏项目。普通会话没有这一项。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<Project>,
}

pub(crate) fn created_without_first_message(err: &str) -> String {
    let detail = err.trim();
    if detail.is_empty() {
        "会话已创建，第一条消息没有发出".to_string()
    } else {
        format!("会话已创建，第一条消息没有发出。{detail}")
    }
}

pub struct FirstSendSpec {
    pub access_mode: Option<String>,
    pub apply_access: bool,
    pub network_access: bool,
    pub writable_roots: Vec<String>,
    pub profile_id: String,
    pub apply_tuning: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub apply_service_tier: bool,
    pub service_tier: Option<String>,
    pub collaboration_mode: Option<String>,
    pub goal: Option<String>,
    pub goal_status: Option<String>,
    pub text: String,
    pub images: Vec<String>,
    pub annotations: Vec<PageAnnotation>,
    pub worktree: bool,
}

pub struct SessionManager {
    entries: Arc<Mutex<HashMap<SessionId, SessionEntry>>>,
    emit: EventEmitter,
    directories: Vec<Arc<dyn SessionDirectory>>,
    opening: tokio::sync::Mutex<()>,
    catalog_cache: CatalogCache,
    permission_cache: PermissionMenuCache,
    recorded: git::RecordedWorktrees,
}

impl SessionManager {
    pub fn new(emit: EventEmitter, data_dir: &std::path::Path) -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            emit,
            directories: session_directories(),
            opening: tokio::sync::Mutex::new(()),
            catalog_cache: CatalogCache::load(data_dir),
            permission_cache: PermissionMenuCache::load(data_dir),
            recorded: git::RecordedWorktrees::new(),
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

    pub fn session_project_id(&self, session_id: &str) -> Option<String> {
        self.entries
            .lock()
            .unwrap()
            .get(session_id)
            .map(|entry| entry.meta.project_id.clone())
    }

    /// 只解析工作台已保存的项目。Agent 目录里的其它 cwd 不能当成项目打开。
    pub fn resolve_project(&self, store: &ProjectStore, id: &str) -> Result<Project, String> {
        let mut project = store.get(id).ok_or_else(|| "项目不存在".to_string())?;
        project.external = false;
        Ok(project)
    }

    /// 侧栏会话。目录 cwd 对上项目路径的留下。
    /// 工作台自己建过的工作树靠标记文件归入这个项目，不对每条会话跑 git。
    /// Codex `thread/list` 不识别工作树；检出是新建会话时另建的，线程 cwd 就是检出目录。
    /// 官方在打开线程之后会不会再解析工作树，仓库资料里没有，标为未观察。
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
        let recorded = self.recorded_for(&project);
        let mut sessions = sidebar_from_listing(&project, &listed, &recorded);
        let live = self.entries.lock().unwrap();
        sessions.retain(|session| {
            live.get(&session.id)
                .map(|entry| !entry.withhold_sidebar)
                .unwrap_or(true)
        });
        for session in &mut sessions {
            if let Some(entry) = live.get(&session.id) {
                session.status = entry.meta.status;
                session.archived = entry.meta.archived;
                if session.title == "未命名会话" && !entry.meta.title.is_empty() {
                    session.title = entry.meta.title.clone();
                }
                if let Some(dir) = entry.meta.workdir.clone().filter(|path| !path.is_empty()) {
                    session.workdir = Some(dir);
                    session.worktree_branch = entry.meta.worktree_branch.clone();
                    session.worktree_base = entry.meta.worktree_base.clone();
                    session.worktree_sha = entry.meta.worktree_sha.clone();
                    session.worktree_owned = entry.meta.worktree_owned;
                }
                // 目录 updatedAt 决定顺序。只有真实对话才并入本进程的活动时间。
                session.updated_at = sidebar_updated_at(session.updated_at, entry.activity_at);
            }
        }
        let mut extras: Vec<Session> = live
            .values()
            .filter(|entry| {
                !entry.withhold_sidebar
                    && entry.meta.project_id == project.id
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
        let found = match self.find_sourced(session_id).await {
            Ok(Some(found)) => Some(found),
            Ok(None) => {
                // 刚创建的线程，或还停在打开前那份 8 秒缓存里时，列表里暂时没有它。
                self.invalidate_session_kind(session_id).await;
                match self.find_sourced(session_id).await {
                    Ok(refreshed) => after_list_refresh(None, refreshed)
                        .map_err(str::to_string)
                        .ok(),
                    Err(err) => return Err(err),
                }
            }
            Err(err) => return Err(err),
        };
        let Some(found) = found else {
            return Err("会话不存在".to_string());
        };
        let projects = store.list();
        let project = self
            .project_for_cwd(&projects, &found.entry.cwd)
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
        let checkout = linked_of(project, &entry.cwd);
        let ctx = SessionContext {
            project_path: checkout
                .as_ref()
                .map(|item| item.cwd.to_string_lossy().to_string())
                .unwrap_or_else(|| project.path.clone()),
            access_mode: None,
            resume_native_id: Some(entry.native_id.clone()),
            options: serde_json::json!({ "persist": true }),
        };
        let handle = adapter_for(agent)
            .start_session(ctx, tx)
            .await
            .map_err(|err| err.to_string())?;
        let mut meta = Session {
            id: session_id,
            project_id: project.id.clone(),
            agent,
            native_id: entry.native_id.clone(),
            title: entry.title.clone(),
            status: entry.status,
            created_at: entry.created_at,
            updated_at: entry.updated_at,
            archived: entry.archived,
            workdir: None,
            worktree_branch: None,
            worktree_base: None,
            worktree_sha: None,
            worktree_owned: false,
        };
        if let Some(checkout) = checkout.as_ref() {
            apply_worktree(&mut meta, project, &checkout.cwd.to_string_lossy());
        }
        self.install(meta, Some(handle), rx, false);
        Ok(())
    }

    /// 启动新会话。Codex 使用 `thread/start` 返回的 thread id，不再另造 UUID。
    pub async fn create_session(
        &self,
        project: &Project,
        agent: AgentKind,
        access_mode: Option<String>,
    ) -> Result<Session, String> {
        self.start_new_session(project, agent, access_mode, false, &[], false)
            .await
    }

    async fn start_new_session(
        &self,
        project: &Project,
        agent: AgentKind,
        access_mode: Option<String>,
        withhold_sidebar: bool,
        writable_roots: &[String],
        worktree: bool,
    ) -> Result<Session, String> {
        let startup = git::WorktreeStart::begin(&project.id)?;
        startup
            .drive(self.start_new_session_guarded(
                project,
                agent,
                access_mode,
                withhold_sidebar,
                writable_roots,
                worktree,
            ))
            .await
    }

    async fn start_new_session_guarded(
        &self,
        project: &Project,
        agent: AgentKind,
        access_mode: Option<String>,
        withhold_sidebar: bool,
        writable_roots: &[String],
        worktree: bool,
    ) -> Result<Session, String> {
        let _refresh_recorded = worktree.then(|| RefreshRecorded(&self.recorded));
        let adapter = adapter_for(agent);
        let caps = adapter.capabilities();
        let prepared = if worktree {
            Some(prepare_session_worktree(&adapter, project, &caps)?)
        } else {
            None
        };
        let (tx, rx) = mpsc::unbounded_channel::<SessionEventBody>();
        let sink: EventSink = tx;
        let mut options = serde_json::json!({ "persist": caps.supports_resume });
        if !writable_roots.is_empty() {
            options["writable_roots"] = serde_json::json!(writable_roots);
        }
        if let Some(item) = prepared.as_ref().and_then(|item| item.cli_name.clone()) {
            options["worktree_name"] = serde_json::json!(item);
        }
        if let Some(item) = prepared.as_ref() {
            options["worktree_path"] = serde_json::json!(item.cwd);
        }
        let project_path = match prepared.as_ref() {
            Some(item) if item.cli_name.is_some() => item.source.clone(),
            Some(item) => item.cwd.clone(),
            None => project.path.clone(),
        };
        let ctx = SessionContext {
            project_path,
            access_mode,
            resume_native_id: None,
            options,
        };
        let handle = match adapter.start_session(ctx, sink).await {
            Ok(handle) => handle,
            Err(err) => {
                rollback_prepared(prepared.as_ref());
                return Err(err.to_string());
            }
        };
        if git::start_was_cancelled() {
            let _ = handle.stop().await;
            rollback_prepared(prepared.as_ref());
            return Err("已停止".into());
        }
        let session_id = match handle.native_id().filter(|id| !id.is_empty()) {
            Some(id) => session_key(agent, &id),
            None if caps.supports_resume => {
                let _ = handle.stop().await;
                rollback_prepared(prepared.as_ref());
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
        if let Some(item) = prepared.as_ref() {
            let cwd = std::path::Path::new(&item.cwd);
            if let Err(err) = git::record_owned_worktree(
                cwd,
                &git::OwnedMarker {
                    root: std::path::PathBuf::from(&item.rollback_root),
                    base: item.base.clone(),
                    sha: item.sha.clone(),
                    branch: item.branch.clone(),
                },
            ) {
                let _ = handle.stop().await;
                rollback_prepared(prepared.as_ref());
                return Err(err);
            }
        }
        let mut meta = Session {
            id: session_id.clone(),
            project_id: project.id.clone(),
            agent,
            native_id,
            title,
            status: SessionStatus::Running,
            created_at: now,
            updated_at: now,
            archived: false,
            workdir: None,
            worktree_branch: None,
            worktree_base: None,
            worktree_sha: None,
            worktree_owned: false,
        };
        if let Some(item) = prepared.as_ref() {
            apply_worktree(&mut meta, project, &item.cwd);
        }
        self.install(meta, Some(handle), rx, withhold_sidebar);
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

    /// 创建、写上草稿里的权限/模型/计划/目标，再发送第一条。
    /// 创建失败则没有会话。会话已在、第一条没发出时保留这条会话。
    pub async fn create_session_and_send(
        &self,
        store: &ProjectStore,
        project: &Project,
        agent: AgentKind,
        spec: FirstSendSpec,
    ) -> Result<CreateAndSendResult, String> {
        let session = self
            .start_new_session(
                project,
                agent,
                spec.access_mode.clone(),
                true,
                &spec.writable_roots,
                spec.worktree,
            )
            .await?;
        let session_id = session.id.clone();
        if let Err(err) = self.apply_first_send(store, &session_id, &spec).await {
            let (exists, landed) = {
                let entries = self.entries.lock().unwrap();
                match entries.get(&session_id) {
                    Some(entry) => (true, !entry.withhold_sidebar),
                    None => (false, false),
                }
            };
            if !exists {
                return Err(err);
            }
            self.release_sidebar(&session_id);
            self.emit_changed(&project.id);
            let session = self
                .entries
                .lock()
                .unwrap()
                .get(&session_id)
                .map(|entry| entry.meta.clone())
                .ok_or_else(|| err.clone())?;
            return Ok(CreateAndSendResult {
                session,
                message_error: if landed {
                    None
                } else {
                    Some(created_without_first_message(&err))
                },
                project: None,
            });
        }
        self.release_sidebar(&session_id);
        self.emit_changed(&project.id);
        self.entries
            .lock()
            .unwrap()
            .get(&session_id)
            .map(|entry| CreateAndSendResult {
                session: entry.meta.clone(),
                message_error: None,
                project: None,
            })
            .ok_or_else(|| "会话没有建立".to_string())
    }

    fn release_sidebar(&self, session_id: &str) {
        let mut entries = self.entries.lock().unwrap();
        if let Some(entry) = entries.get_mut(session_id) {
            entry.withhold_sidebar = false;
        }
    }

    /// 创建被取消，而且用户消息还没落地。已经发出的会话不会撤。
    pub async fn discard_unsent_session(&self, session_id: &str) -> Result<(), String> {
        let unsent = {
            let entries = self.entries.lock().unwrap();
            let Some(entry) = entries.get(session_id) else {
                return Ok(());
            };
            !entry
                .events
                .iter()
                .any(|event| matches!(event.body, SessionEventBody::UserMessage { .. }))
        };
        if !unsent {
            return Err("这条会话已经有消息".into());
        }
        self.abandon_unsent(session_id).await;
        Ok(())
    }

    async fn apply_first_send(
        &self,
        store: &ProjectStore,
        session_id: &str,
        spec: &FirstSendSpec,
    ) -> Result<(), String> {
        if spec.apply_access {
            self.set_session_access(
                store,
                session_id,
                spec.access_mode.as_deref().unwrap_or("ask"),
                spec.network_access,
                spec.writable_roots.clone(),
                spec.profile_id.clone(),
            )
            .await?;
        }
        if spec.apply_tuning {
            self.set_session_tuning(store, session_id, spec.model.clone(), spec.effort.clone())
                .await?;
        }
        if spec.apply_service_tier {
            self.set_session_service_tier(store, session_id, spec.service_tier.clone())
                .await?;
        }
        if spec.collaboration_mode.as_deref() == Some("plan") {
            self.set_collaboration_mode(store, session_id, "plan")
                .await?;
        }
        if let Some(goal) = spec
            .goal
            .as_deref()
            .map(str::trim)
            .filter(|goal| !goal.is_empty())
        {
            self.set_thread_goal(store, session_id, goal).await?;
            if spec.goal_status.as_deref() == Some("paused") {
                self.set_thread_goal_status(store, session_id, "paused")
                    .await?;
            }
        }
        self.send_message(
            session_id,
            spec.text.clone(),
            spec.images.clone(),
            spec.annotations.clone(),
        )
        .await
    }

    async fn abandon_unsent(&self, session_id: &str) {
        let Some((agent, native, project_id)) = ({
            let entries = self.entries.lock().unwrap();
            entries.get(session_id).map(|entry| {
                (
                    entry.meta.agent,
                    entry.meta.native_id.clone(),
                    entry.meta.project_id.clone(),
                )
            })
        }) else {
            return;
        };
        if let Some(handle) = self.lookup_agent(session_id) {
            let _ = handle.stop().await;
        }
        let _ = adapter_for(agent).discard_unsent_thread(&native).await;
        self.entries.lock().unwrap().remove(session_id);
        self.emit_changed(&project_id);
    }

    pub fn cached_agent_catalog(&self, kind: AgentKind) -> Result<AgentCatalogRefresh, String> {
        let catalog = self
            .catalog_cache
            .get(kind)
            .filter(|catalog| catalog.agent.is_none_or(|agent| agent == kind))
            .ok_or_else(|| "没有已保存的模型列表".to_string())?;
        Ok(AgentCatalogRefresh {
            catalog,
            notice: None,
        })
    }

    pub fn draft_permission_menu(&self, kind: AgentKind) -> crate::models::PermissionMenu {
        if let Some(mut menu) = self.permission_cache.get(kind) {
            menu.active = None;
            return menu;
        }
        let mut menu = adapter_for(kind).draft_permission_menu();
        menu.active = None;
        menu
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
        withhold_sidebar: bool,
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
                withhold_sidebar,
            },
        );
        // start_session 返回前已经把历史、连接说明和状态放进通道。
        // 这些是打开/附着，不能改侧边栏排序时间。
        while let Ok(body) = rx.try_recv() {
            apply_body(&self.entries, &self.emit, &session_id, body, false);
        }
        let entries = Arc::clone(&self.entries);
        let emit = Arc::clone(&self.emit);
        let sid = session_id;
        tauri::async_runtime::spawn(async move {
            while let Some(body) = rx.recv().await {
                apply_body(&entries, &emit, &sid, body, true);
            }
        });
    }

    /// 追加本地产生的事件（用户消息 / 本地错误），并广播。
    fn record_local(&self, session_id: &str, body: SessionEventBody) -> Result<(), String> {
        if !self.entries.lock().unwrap().contains_key(session_id) {
            return Err("会话不存在".to_string());
        }
        apply_body(&self.entries, &self.emit, session_id, body, true);
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

    /// 计划、调参、权限和翻页历史都可能赶在打开之前。
    /// 有人正在打开就等它；否则再确保一次。仍没有句柄，会话才是真的不在。
    async fn open_agent(
        &self,
        store: &ProjectStore,
        session_id: &str,
    ) -> Result<Arc<dyn AgentSession>, String> {
        command_when_ready(
            &self.opening,
            || {
                let result = self.agent_handle(session_id);
                async move { result }
            },
            || async { self.ensure_events(store, session_id).await.map(|_| ()) },
        )
        .await
    }

    pub async fn set_collaboration_mode(
        &self,
        store: &ProjectStore,
        session_id: &str,
        mode: &str,
    ) -> Result<(), String> {
        let handle = self.open_agent(store, session_id).await?;
        handle
            .set_collaboration_mode(mode)
            .map_err(|err| err.to_string())
    }

    pub async fn set_thread_goal(
        &self,
        store: &ProjectStore,
        session_id: &str,
        objective: &str,
    ) -> Result<(), String> {
        let handle = self.open_agent(store, session_id).await?;
        handle
            .set_goal(objective)
            .await
            .map_err(|err| err.to_string())
    }

    pub async fn clear_thread_goal(
        &self,
        store: &ProjectStore,
        session_id: &str,
    ) -> Result<(), String> {
        let handle = self.open_agent(store, session_id).await?;
        handle.clear_goal().await.map_err(|err| err.to_string())
    }

    pub async fn publish_thread_goal(
        &self,
        store: &ProjectStore,
        session_id: &str,
    ) -> Result<(), String> {
        let handle = self.open_agent(store, session_id).await?;
        handle.publish_goal().await.map_err(|err| err.to_string())
    }

    pub async fn set_thread_goal_status(
        &self,
        store: &ProjectStore,
        session_id: &str,
        status: &str,
    ) -> Result<(), String> {
        let handle = self.open_agent(store, session_id).await?;
        handle
            .set_goal_status(status)
            .await
            .map_err(|err| err.to_string())
    }

    pub async fn start_review(&self, session_id: &str, target: ReviewStart) -> Result<(), String> {
        let handle = self.agent_handle_ready(session_id).await?;
        if handle.read_only() {
            return Err(OCCUPIED_SESSION_NOTICE.to_string());
        }
        handle
            .start_review(target)
            .await
            .map_err(|err| err.to_string())
    }

    pub async fn review_targets(&self, session_id: &str) -> Result<ReviewTargets, String> {
        let handle = self.agent_handle_ready(session_id).await?;
        handle.review_targets().await.map_err(|err| err.to_string())
    }

    pub async fn load_older_history(
        &self,
        store: &ProjectStore,
        session_id: &str,
    ) -> Result<OlderHistory, String> {
        let handle = self.open_agent(store, session_id).await?;
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

    pub async fn send_message(
        &self,
        session_id: &str,
        text: String,
        images: Vec<String>,
        annotations: Vec<crate::models::PageAnnotation>,
    ) -> Result<(), String> {
        let handle = self.agent_handle_ready(session_id).await?;
        if handle.read_only() {
            return Err(OCCUPIED_SESSION_NOTICE.to_string());
        }
        let slash = text.starts_with('/') && images.is_empty() && annotations.is_empty();
        let display = text;
        let note_count = u32::try_from(annotations.len()).unwrap_or(u32::MAX);
        let mut recorded_images = images.clone();
        for note in &annotations {
            if let Some(path) = note
                .screenshot
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty())
            {
                if !recorded_images.iter().any(|item| item == path) {
                    recorded_images.push(path.to_string());
                }
            }
        }
        if display.trim().is_empty() && recorded_images.is_empty() && annotations.is_empty() {
            return Err("消息不能为空".into());
        }
        // 斜杠命令不写成用户气泡（与 Codex TUI 一致）；命令自己要发出的提示由适配器写。
        if slash {
            return handle
                .send_message(display)
                .await
                .map_err(|err| err.to_string());
        }
        let client_id = new_id();
        let delivery = handle
            .deliver(UserTurn {
                text: display.clone(),
                images,
                client_id,
                annotations,
            })
            .await
            .map_err(|err| err.to_string())?;
        if delivery == TurnDelivery::Started {
            self.record_local(
                session_id,
                SessionEventBody::UserMessage {
                    text: display,
                    images: recorded_images,
                    annotations: note_count,
                },
            )?;
        }
        Ok(())
    }

    /// 提交一条页面批注。排队时不写气泡，等队列真正发出时再记。
    pub async fn submit_annotation(
        &self,
        session_id: &str,
        note: PageAnnotation,
    ) -> Result<(), String> {
        let handle = self.agent_handle_ready(session_id).await?;
        if handle.read_only() {
            return Err(OCCUPIED_SESSION_NOTICE.to_string());
        }
        let comment = note.comment.trim().to_string();
        let mut images = Vec::new();
        if let Some(path) = note
            .screenshot
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            images.push(path.to_string());
        }
        let delivery = handle
            .submit_annotation(note)
            .await
            .map_err(|err| err.to_string())?;
        if delivery == TurnDelivery::Started {
            self.record_local(
                session_id,
                SessionEventBody::UserMessage {
                    text: comment,
                    images,
                    annotations: 1,
                },
            )?;
        }
        Ok(())
    }

    pub async fn diff_scopes(&self, session_id: &str) -> Result<Vec<DiffScope>, String> {
        let handle = self.agent_handle_ready(session_id).await?;
        handle.diff_scopes().await.map_err(|err| err.to_string())
    }

    pub async fn diff_for_scope(
        &self,
        store: &ProjectStore,
        session_id: &str,
        scope: &str,
        ignore_whitespace: bool,
    ) -> Result<String, String> {
        let project_id = self
            .entries
            .lock()
            .unwrap()
            .get(session_id)
            .map(|entry| entry.meta.project_id.clone())
            .ok_or_else(|| "会话不存在".to_string())?;
        let project = self.resolve_project(store, &project_id)?;
        let root = self
            .work_root(&project, Some(session_id))
            .unwrap_or_else(|_| std::path::PathBuf::from(&project.path));
        let handle = self.agent_handle_ready(session_id).await?;
        handle
            .diff_for_scope(&root.to_string_lossy(), scope, ignore_whitespace)
            .await
            .map_err(|err| err.to_string())
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
                    annotations: Vec::new(),
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

    pub async fn steer_queued_turn(&self, session_id: &str, queued_id: &str) -> Result<(), String> {
        let handle = self.agent_handle_ready(session_id).await?;
        handle
            .steer_queued(queued_id)
            .await
            .map_err(|err| err.to_string())
    }

    pub async fn set_follow_up_queue_mode(
        &self,
        session_id: &str,
        mode: &str,
    ) -> Result<(), String> {
        let handle = self.agent_handle_ready(session_id).await?;
        handle
            .set_follow_up_queue_mode(mode)
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
        let previous = self
            .catalog_cache
            .get(kind)
            .filter(|catalog| catalog.agent.is_none_or(|agent| agent == kind));
        let incoming = handle
            .catalog()
            .await
            .map_err(|err| err.to_string())
            .and_then(|mut catalog| {
                if catalog.agent.is_some_and(|agent| agent != kind) {
                    return Err("模型列表与当前会话不符".into());
                }
                catalog.agent = Some(kind);
                Ok(catalog)
            });
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

    pub async fn set_session_tuning(
        &self,
        store: &ProjectStore,
        session_id: &str,
        model: Option<String>,
        effort: Option<String>,
    ) -> Result<(), String> {
        let handle = self.open_agent(store, session_id).await?;
        handle
            .set_tuning(model, effort)
            .map_err(|err| err.to_string())
    }

    pub async fn set_session_service_tier(
        &self,
        store: &ProjectStore,
        session_id: &str,
        service_tier: Option<String>,
    ) -> Result<(), String> {
        let handle = self.open_agent(store, session_id).await?;
        handle
            .set_service_tier(service_tier)
            .map_err(|err| err.to_string())
    }

    pub async fn set_session_access(
        &self,
        store: &ProjectStore,
        session_id: &str,
        mode: &str,
        network_access: bool,
        writable_roots: Vec<String>,
        profile_id: String,
    ) -> Result<(), String> {
        let handle = self.open_agent(store, session_id).await?;
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
        let menu = handle
            .permission_menu()
            .await
            .map_err(|err| err.to_string())?;
        if let Some(kind) = self
            .entries
            .lock()
            .unwrap()
            .get(session_id)
            .map(|entry| entry.meta.agent)
        {
            self.permission_cache.remember(kind, &menu);
        }
        Ok(menu)
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
        (self.emit)(
            EVT_SESSIONS_CHANGED,
            serde_json::json!({ "project_id": project_id }),
        );
    }

    async fn invalidate_kind(&self, agent: AgentKind) {
        for directory in &self.directories {
            if directory.kind() == agent {
                directory.invalidate().await;
            }
        }
    }

    async fn invalidate_session_kind(&self, session_id: &str) {
        if let Some((agent, _)) = parse_session_key(session_id) {
            self.invalidate_kind(agent).await;
            return;
        }
        for directory in &self.directories {
            directory.invalidate().await;
        }
    }

    /// 在活动目录里找这条会话。目录自己失败且一份都没列出时，把那个错误交回去。
    async fn find_sourced(&self, session_id: &str) -> Result<Option<SourcedEntry>, String> {
        let (listed, errors) = self.listed().await;
        let found = listed
            .iter()
            .find(|item| session_key(item.agent, &item.entry.native_id) == session_id)
            .cloned();
        if found.is_some() {
            return Ok(found);
        }
        if listed.is_empty() {
            if let Some(err) = errors.into_iter().next() {
                return Err(err);
            }
        }
        Ok(None)
    }

    fn emit_changed(&self, project_id: &str) {
        (self.emit)(
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
        let found = active
            .iter()
            .find(|item| item.agent == agent && item.entry.native_id == native);
        let Some(found) = found else {
            return Err("会话不存在".into());
        };
        let projects = store.list();
        let project = self
            .project_for_cwd(&projects, &found.entry.cwd)
            .ok_or_else(|| "找不到会话所在目录".to_string())?;
        Ok((agent, native, project))
    }

    async fn session_cwd(&self, session_id: &str, native: &str, agent: AgentKind) -> String {
        let from_entry = self
            .entries
            .lock()
            .unwrap()
            .get(session_id)
            .and_then(|entry| entry.meta.workdir.clone())
            .filter(|path| !path.trim().is_empty());
        if let Some(path) = from_entry {
            return path;
        }
        let (active, _) = self.listed().await;
        active
            .iter()
            .find(|item| item.agent == agent && item.entry.native_id == native)
            .map(|item| item.entry.cwd.clone())
            .unwrap_or_default()
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

    pub async fn worktree_delete_preview(
        &self,
        store: &ProjectStore,
        session_id: &str,
    ) -> Result<git::DeletePreview, String> {
        let (agent, native, project) = self.locate_session(store, session_id).await?;
        let cwd = self.session_cwd(session_id, &native, agent).await;
        if cwd.is_empty() {
            return Ok(git::DeletePreview {
                owned: false,
                dirty: false,
            });
        }
        Ok(git::delete_preview(
            std::path::Path::new(&project.path),
            std::path::Path::new(&cwd),
        ))
    }

    pub async fn delete_session(
        &self,
        store: &ProjectStore,
        session_id: &str,
        discard_worktree: bool,
        force_worktree: bool,
    ) -> Result<(), String> {
        let (agent, native, project) = self.locate_session(store, session_id).await?;
        let adapter = adapter_for(agent);
        if !adapter.capabilities().supports_delete {
            return Err(format!("{} 不支持永久删除", adapter.display_name()));
        }
        if discard_worktree {
            let cwd = self.session_cwd(session_id, &native, agent).await;
            if !cwd.is_empty() {
                // 没有错误返回：登记、目录或分支清不掉也不能让「无法删除任务」把会话留住。
                // 已打开的 Agent 若正站在工作树里，Windows 会拒绝删掉这个空目录。先停进程。
                if let Some(handle) = self.lookup_agent(session_id) {
                    let _ = handle.stop().await;
                }
                git::discard_confirmed_worktree(
                    std::path::Path::new(&project.path),
                    std::path::Path::new(&cwd),
                    force_worktree,
                );
                self.recorded.invalidate();
            }
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

    pub async fn set_session_archived(
        &self,
        store: &ProjectStore,
        session_id: &str,
        archived: bool,
    ) -> Result<(), String> {
        let (agent, native, project) = self.locate_session(store, session_id).await?;
        let adapter = adapter_for(agent);
        if !adapter.capabilities().supports_archive {
            return Err(format!("{} 不支持归档", adapter.display_name()));
        }
        if let Err(first) = adapter.set_archived(&native, archived).await {
            if !archived {
                return Err(first.to_string());
            }
            // 已打开的线程占着写锁时，`thread/archive` 会拒绝。先停再试一次。
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
                .set_archived(&native, true)
                .await
                .map_err(|_| first.to_string())?;
        }
        if let Some(entry) = self.entries.lock().unwrap().get_mut(session_id) {
            entry.meta.archived = archived;
        }
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
            workdir: None,
            worktree_branch: None,
            worktree_base: None,
            worktree_sha: None,
            worktree_owned: false,
        };
        // 父会话的 updated_at / activity_at 不动。打开分支走既有 resume。
        let _ = self.attach(&project, agent, &forked).await;
        self.invalidate_kind(agent).await;
        self.emit_changed(&project.id);
        let opened = self
            .entries
            .lock()
            .unwrap()
            .get(&session.id)
            .map(|entry| entry.meta.clone());
        Ok(opened.unwrap_or(session))
    }
}

fn apply_worktree(session: &mut Session, project: &Project, cwd: &str) {
    let Some(info) = git::session_worktree(
        std::path::Path::new(&project.path),
        std::path::Path::new(cwd),
    ) else {
        return;
    };
    session.workdir = Some(info.cwd.to_string_lossy().to_string());
    session.worktree_branch = info.branch;
    session.worktree_base = info.base;
    session.worktree_sha = info.sha;
    session.worktree_owned = info.owned;
}

fn prepare_session_worktree(
    adapter: &Arc<dyn crate::features::agents::AgentAdapter>,
    project: &Project,
    caps: &AgentCapabilities,
) -> Result<PreparedWorktree, String> {
    if project.standalone {
        return Err("独立聊天不能使用工作树".into());
    }
    if !caps.supports_worktree {
        return Err("当前 Agent 不能在工作树里运行".into());
    }
    let source = std::path::PathBuf::from(&project.path);
    if !git::repo_has_commit(&source)? {
        return Err("这个目录还没有 Git 提交，不能新建工作树。".into());
    }
    adapter
        .prepare_worktree(&source)
        .map_err(|err| err.to_string())
}

fn rollback_prepared(prepared: Option<&PreparedWorktree>) {
    let Some(prepared) = prepared else {
        return;
    };
    git::remove_checkout(
        std::path::Path::new(&prepared.source),
        std::path::Path::new(&prepared.rollback_root),
    );
}

fn linked_of(project: &Project, cwd: &str) -> Option<Checkout> {
    if project.standalone || cwd.trim().is_empty() {
        return None;
    }
    git::linked_checkout(
        std::path::Path::new(&project.path),
        std::path::Path::new(cwd),
    )
    .ok()
    .flatten()
}

struct RefreshRecorded<'a>(&'a git::RecordedWorktrees);

impl Drop for RefreshRecorded<'_> {
    fn drop(&mut self) {
        self.0.invalidate();
    }
}

fn sidebar_from_listing(
    project: &Project,
    listed: &[SourcedEntry],
    recorded: &[git::RecordedCheckout],
) -> Vec<Session> {
    let mut sessions = sessions_for_project(project, listed);
    attach_recorded_worktrees(project, listed, recorded, &mut sessions);
    sessions
}

/// 只并入带工作台标记的检出。不调用 `linked_checkout`。
fn attach_recorded_worktrees(
    project: &Project,
    listed: &[SourcedEntry],
    recorded: &[git::RecordedCheckout],
    sessions: &mut Vec<Session>,
) {
    if project.standalone || recorded.is_empty() {
        return;
    }
    for item in listed {
        if item.entry.ephemeral {
            continue;
        }
        let Some(checkout) = recorded
            .iter()
            .find(|row| git::checkout_contains(row, &item.entry.cwd))
        else {
            continue;
        };
        if let Some(session) = sessions.iter_mut().find(|session| {
            session.agent == item.agent && session.native_id == item.entry.native_id
        }) {
            fill_recorded(session, &item.entry.cwd, checkout);
            continue;
        }
        let mut session = Session {
            id: session_key(item.agent, &item.entry.native_id),
            project_id: project.id.clone(),
            agent: item.agent,
            native_id: item.entry.native_id.clone(),
            title: item.entry.title.clone(),
            status: item.entry.status,
            created_at: item.entry.created_at,
            updated_at: item.entry.updated_at,
            archived: item.entry.archived,
            workdir: None,
            worktree_branch: None,
            worktree_base: None,
            worktree_sha: None,
            worktree_owned: false,
        };
        fill_recorded(&mut session, &item.entry.cwd, checkout);
        sessions.push(session);
    }
}

fn fill_recorded(session: &mut Session, cwd: &str, checkout: &git::RecordedCheckout) {
    session.workdir = Some(cwd.to_string());
    session.worktree_branch = checkout.branch.clone();
    session.worktree_base = checkout.base.clone();
    session.worktree_sha = Some(checkout.sha.clone());
    session.worktree_owned = true;
}

impl SessionManager {
    /// 文件树、预览和 git 用的目录。工作树会话指向检出，其余指向项目。
    pub fn work_root(
        &self,
        project: &Project,
        session_id: Option<&str>,
    ) -> Result<std::path::PathBuf, String> {
        let Some(session_id) = session_id.map(str::trim).filter(|id| !id.is_empty()) else {
            return Ok(std::path::PathBuf::from(&project.path));
        };
        let workdir = self
            .entries
            .lock()
            .unwrap()
            .get(session_id)
            .and_then(|entry| entry.meta.workdir.clone());
        let Some(workdir) = workdir.filter(|path| !path.is_empty()) else {
            return Ok(std::path::PathBuf::from(&project.path));
        };
        if self
            .entries
            .lock()
            .unwrap()
            .get(session_id)
            .map(|entry| entry.meta.project_id != project.id)
            .unwrap_or(true)
        {
            return Err("工作树不属于这个项目".into());
        }
        if !self.workdir_belongs(project, &workdir) {
            return Err("工作树不属于这个项目".into());
        }
        Ok(std::path::PathBuf::from(workdir))
    }

    fn recorded_for(&self, project: &Project) -> Vec<git::RecordedCheckout> {
        if project.standalone {
            return Vec::new();
        }
        self.recorded.for_path(
            std::path::Path::new(&project.path),
            &git::codex_worktree_root(),
        )
    }

    /// 先对路径，再对工作台记过的检出。都不是时才对这一条 cwd 跑 git。
    fn project_for_cwd(&self, projects: &[Project], cwd: &str) -> Option<Project> {
        let key = crate::features::agents::cwd_key(cwd);
        if let Some(project) = projects
            .iter()
            .find(|project| project_matches_cwd(project, &key))
        {
            return Some(project.clone());
        }
        if let Some(project) = projects.iter().find(|project| {
            !project.standalone && git::checkout_matches(&self.recorded_for(project), cwd)
        }) {
            return Some(project.clone());
        }
        projects
            .iter()
            .find(|project| linked_of(project, cwd).is_some())
            .cloned()
    }

    fn workdir_belongs(&self, project: &Project, workdir: &str) -> bool {
        if project.standalone {
            return false;
        }
        git::checkout_matches(&self.recorded_for(project), workdir)
            || linked_of(project, workdir).is_some()
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

#[cfg(test)]
mod tests {
    use super::{created_without_first_message, sidebar_from_listing};
    use crate::features::agents::{DirectoryEntry, SourcedEntry};
    use crate::features::git::RecordedWorktrees;
    use crate::models::{AgentKind, SessionStatus};
    use std::fs;
    use std::path::{Path, PathBuf};

    #[test]
    fn partial_send_names_the_created_session_and_the_missed_message() {
        assert_eq!(
            created_without_first_message("连接中断"),
            "会话已创建，第一条消息没有发出。连接中断"
        );
        assert_eq!(
            created_without_first_message("  "),
            "会话已创建，第一条消息没有发出"
        );
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-workbench-sidebar-wt-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn project_at(path: &Path) -> crate::models::Project {
        crate::models::Project {
            id: "saved".into(),
            name: "已保存".into(),
            path: path.to_string_lossy().to_string(),
            folders: Vec::new(),
            default_agent: AgentKind::CodexCli,
            created_at: 1,
            updated_at: 2,
            external: false,
            standalone: false,
        }
    }

    fn sourced(id: &str, cwd: &Path) -> SourcedEntry {
        SourcedEntry {
            agent: AgentKind::CodexCli,
            entry: DirectoryEntry {
                native_id: id.into(),
                cwd: cwd.to_string_lossy().to_string(),
                cwd_key: crate::features::agents::cwd_key(&cwd.to_string_lossy()),
                title: id.into(),
                created_at: 10,
                updated_at: 20,
                status: SessionStatus::Completed,
                ephemeral: false,
                archived: false,
            },
        }
    }

    #[test]
    fn sidebar_listing_does_not_run_linked_worktree_git() {
        let repo = scratch("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let gitdir = repo.join(".git").join("worktrees").join("demo");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        let managed = scratch("managed");
        let checkout = managed.join("ab12").join("demo");
        let nested = checkout.join("src");
        fs::create_dir_all(&nested).unwrap();
        fs::write(
            checkout.join(".git"),
            format!("gitdir: {}\n", gitdir.display()),
        )
        .unwrap();
        fs::write(
            gitdir.join("ai-workbench-worktree.json"),
            serde_json::json!({
                "version": 1,
                "base": "main",
                "sha": "abcdef1234567890",
                "root": checkout,
            })
            .to_string(),
        )
        .unwrap();

        let mut listed = vec![sourced("inside", &repo), sourced("worktree", &nested)];
        let mut extras = Vec::new();
        for index in 0..12 {
            let dir = scratch(&format!("other-{index}"));
            extras.push(dir.clone());
            listed.push(sourced(&format!("other-{index}"), &dir));
        }
        let mut skipped = sourced("ghost", &nested);
        skipped.entry.ephemeral = true;
        skipped.entry.native_id = "ghost".into();
        listed.push(skipped);

        let index = RecordedWorktrees::new();
        let guard = crate::features::git::block_git();
        let recorded = index.for_path(&repo, &managed);
        let sessions = sidebar_from_listing(&project_at(&repo), &listed, &recorded);
        assert_eq!(guard.calls(), 0, "列会话不能为了工作树启动 git");
        drop(guard);

        assert_eq!(recorded.len(), 1);
        let home = sessions
            .iter()
            .find(|item| item.native_id == "inside")
            .unwrap();
        assert!(home.workdir.is_none());
        assert!(!home.worktree_owned);
        let marked = sessions
            .iter()
            .find(|item| item.native_id == "worktree")
            .unwrap();
        let workdir = marked.workdir.as_deref().unwrap().replace('\\', "/");
        assert!(workdir.ends_with("demo/src"), "{workdir}");
        assert_eq!(marked.worktree_base.as_deref(), Some("main"));
        assert_eq!(marked.worktree_sha.as_deref(), Some("abcdef1234567890"));
        assert!(marked.worktree_owned);
        assert!(sessions
            .iter()
            .all(|item| !item.native_id.starts_with("other-")));
        assert!(sessions.iter().all(|item| item.native_id != "ghost"));

        let _ = fs::remove_dir_all(&repo);
        let _ = fs::remove_dir_all(&managed);
        for dir in extras {
            let _ = fs::remove_dir_all(dir);
        }
    }
}
