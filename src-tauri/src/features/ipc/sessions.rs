//! 会话命令。模型目录、调参和回答提问都转给当前会话的适配器。

use serde::Deserialize;
use tauri::{AppHandle, Runtime, State};

use crate::features::agents::DiffScope;
use crate::features::chats::{self, TaskFolderStore};
use crate::features::projects::ProjectStore;
use crate::features::sessions::{
    AgentCatalogRefresh, CreateAndSendResult, FirstSendSpec, SessionManager,
};
use crate::models::*;

use super::chats::host_documents;
use super::projects::notify_projects_changed;

#[tauri::command]
pub async fn list_sessions(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    project_id: String,
) -> Result<Vec<Session>, String> {
    Ok(manager.sessions_for_sidebar(&store, &project_id).await)
}

#[tauri::command]
pub async fn fork_session(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<Session, String> {
    manager.fork_session(&store, &session_id).await
}

#[tauri::command]
pub async fn rename_session(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
    name: String,
) -> Result<(), String> {
    manager.rename_session(&store, &session_id, &name).await
}

#[tauri::command]
pub async fn set_session_archived(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
    archived: bool,
) -> Result<(), String> {
    manager
        .set_session_archived(&store, &session_id, archived)
        .await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDeletePreview {
    pub owned: bool,
    pub dirty: bool,
}

#[tauri::command]
pub async fn session_worktree_delete_preview(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<WorktreeDeletePreview, String> {
    let preview = manager.worktree_delete_preview(&store, &session_id).await?;
    Ok(WorktreeDeletePreview { owned: preview.owned, dirty: preview.dirty })
}

#[tauri::command]
pub async fn delete_session(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
    discard_worktree: Option<bool>,
    force_worktree: Option<bool>,
) -> Result<(), String> {
    manager
        .delete_session(
            &store,
            &session_id,
            discard_worktree.unwrap_or(false),
            force_worktree.unwrap_or(false),
        )
        .await
}

/// 草稿首发：创建、写入权限/模型/计划/目标，再发送第一条。
/// 创建失败没有会话；会话已在但第一条没发出时保留会话。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAndSendInput {
    project_id: String,
    agent: AgentKind,
    access_mode: Option<String>,
    network_access: bool,
    writable_roots: Vec<String>,
    profile_id: String,
    apply_access: bool,
    model: Option<String>,
    effort: Option<String>,
    apply_tuning: bool,
    service_tier: Option<String>,
    apply_service_tier: bool,
    collaboration_mode: Option<String>,
    goal: Option<String>,
    goal_status: Option<String>,
    text: String,
    #[serde(default)]
    images: Vec<String>,
    #[serde(default)]
    annotations: Vec<PageAnnotation>,
    /// 首发时才建任务目录。草稿阶段还没有项目。
    #[serde(default)]
    standalone: bool,
    /// 在一个新的 Git 工作树里运行。
    #[serde(default)]
    worktree: bool,
}

/// 停止还没建立完的会话。创建命令自己返回后，前端再解锁草稿。
#[tauri::command]
pub fn cancel_session_start(project_id: String) {
    crate::features::git::cancel_worktree_start(&project_id);
}

#[tauri::command]
pub async fn create_session_and_send<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, ProjectStore>,
    folders: State<'_, TaskFolderStore>,
    manager: State<'_, SessionManager>,
    input: CreateAndSendInput,
) -> Result<CreateAndSendResult, String> {
    let project = if input.standalone {
        let root = folders.current(&host_documents(&app));
        chats::provision_standalone_chat(&store, &root, &input.text, input.agent, &chats::today())?
    } else {
        manager.resolve_project(&store, &input.project_id)?
    };
    let result = manager
        .create_session_and_send(
            &store,
            &project,
            input.agent,
            FirstSendSpec {
                access_mode: input.access_mode,
                apply_access: input.apply_access,
                network_access: input.network_access,
                writable_roots: input.writable_roots,
                profile_id: input.profile_id,
                apply_tuning: input.apply_tuning,
                model: input.model,
                effort: input.effort,
                apply_service_tier: input.apply_service_tier,
                service_tier: input.service_tier,
                collaboration_mode: input.collaboration_mode,
                goal: input.goal,
                goal_status: input.goal_status,
                text: input.text,
                images: input.images,
                annotations: input.annotations,
                worktree: input.worktree,
            },
        )
        .await;
    match result {
        Ok(mut created) => {
            if input.standalone {
                created.project = Some(project);
            }
            Ok(created)
        }
        Err(err) => {
            if input.standalone {
                chats::rollback_standalone(&store, &project);
            }
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn discard_unsent_session<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<(), String> {
    let project_id = manager.session_project_id(&session_id);
    manager.discard_unsent_session(&session_id).await?;
    if let Some(project_id) = project_id {
        forget_empty_standalone(&app, &store, &manager, &project_id).await;
    }
    Ok(())
}

async fn forget_empty_standalone<R: Runtime>(
    app: &AppHandle<R>,
    store: &ProjectStore,
    manager: &SessionManager,
    project_id: &str,
) {
    let Some(project) = store.get(project_id) else {
        return;
    };
    if !project.standalone {
        return;
    }
    if !manager.sessions_for_sidebar(store, project_id).await.is_empty() {
        return;
    }
    if store.remove(project_id).unwrap_or(false) {
        chats::remove_empty_dir(&project.path);
        notify_projects_changed(app);
    }
}

#[tauri::command]
pub fn cached_agent_catalog(
    manager: State<'_, SessionManager>,
    agent: AgentKind,
) -> Result<AgentCatalogRefresh, String> {
    manager.cached_agent_catalog(agent)
}

#[tauri::command]
pub fn agent_permission_menu(
    manager: State<'_, SessionManager>,
    agent: AgentKind,
) -> PermissionMenu {
    manager.draft_permission_menu(agent)
}

/// 创建会话；agent 缺省时用项目默认 Agent。
#[tauri::command]
pub async fn create_session(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    project_id: String,
    agent: Option<AgentKind>,
    access_mode: Option<String>,
) -> Result<Session, String> {
    let project = manager.resolve_project(&store, &project_id)?;
    manager
        .create_session(
            &project,
            agent.unwrap_or(project.default_agent),
            access_mode,
        )
        .await
}

#[tauri::command]
pub async fn agent_catalog(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<AgentCatalogRefresh, String> {
    manager.agent_catalog_when_ready(&store, &session_id).await
}

#[tauri::command]
pub async fn set_session_tuning(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    manager
        .set_session_tuning(&store, &session_id, model, effort)
        .await
}

#[tauri::command]
pub async fn set_session_service_tier(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
    service_tier: Option<String>,
) -> Result<(), String> {
    manager
        .set_session_service_tier(&store, &session_id, service_tier)
        .await
}

#[tauri::command]
pub async fn set_session_access(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
    mode: String,
    network_access: Option<bool>,
    writable_roots: Option<Vec<String>>,
    profile_id: Option<String>,
) -> Result<(), String> {
    manager
        .set_session_access(
            &store,
            &session_id,
            &mode,
            network_access.unwrap_or(false),
            writable_roots.unwrap_or_default(),
            profile_id.unwrap_or_default(),
        )
        .await
}

#[tauri::command]
pub async fn session_permission_menu(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<PermissionMenu, String> {
    manager.permission_menu(&store, &session_id).await
}

#[tauri::command]
pub async fn set_collaboration_mode(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
    mode: String,
) -> Result<(), String> {
    manager
        .set_collaboration_mode(&store, &session_id, &mode)
        .await
}

#[tauri::command]
pub async fn set_thread_goal(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
    objective: String,
) -> Result<(), String> {
    manager
        .set_thread_goal(&store, &session_id, &objective)
        .await
}

#[tauri::command]
pub async fn clear_thread_goal(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<(), String> {
    manager.clear_thread_goal(&store, &session_id).await
}

#[tauri::command]
pub async fn publish_thread_goal(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<(), String> {
    manager.publish_thread_goal(&store, &session_id).await
}

#[tauri::command]
pub async fn set_thread_goal_status(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
    status: String,
) -> Result<(), String> {
    manager
        .set_thread_goal_status(&store, &session_id, &status)
        .await
}

#[tauri::command]
pub async fn review_targets(
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<crate::models::ReviewTargets, String> {
    manager.review_targets(&session_id).await
}

#[tauri::command]
pub async fn start_review(
    manager: State<'_, SessionManager>,
    session_id: String,
    target: crate::models::ReviewStart,
) -> Result<(), String> {
    manager.start_review(&session_id, target).await
}

#[tauri::command]
pub async fn send_message(
    manager: State<'_, SessionManager>,
    session_id: String,
    text: String,
    images: Option<Vec<String>>,
    annotations: Option<Vec<PageAnnotation>>,
) -> Result<(), String> {
    let text = text.trim().to_string();
    let images = images.unwrap_or_default();
    let annotations = annotations.unwrap_or_default();
    if text.is_empty() && images.is_empty() && annotations.is_empty() {
        return Err("消息不能为空".into());
    }
    manager
        .send_message(&session_id, text, images, annotations)
        .await
}

#[tauri::command]
pub async fn submit_annotation(
    manager: State<'_, SessionManager>,
    session_id: String,
    note: PageAnnotation,
) -> Result<(), String> {
    manager.submit_annotation(&session_id, note).await
}

#[tauri::command]
pub async fn diff_scopes(
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<Vec<DiffScope>, String> {
    manager.diff_scopes(&session_id).await
}

#[tauri::command]
pub async fn diff_for_scope(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
    scope: String,
    ignore_whitespace: bool,
) -> Result<String, String> {
    manager
        .diff_for_scope(&store, &session_id, &scope, ignore_whitespace)
        .await
}

#[tauri::command]
pub async fn update_queued_turn(
    manager: State<'_, SessionManager>,
    session_id: String,
    queued_id: String,
    text: String,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    manager
        .update_queued_turn(
            &session_id,
            &queued_id,
            text.trim().to_string(),
            images.unwrap_or_default(),
        )
        .await
}

#[tauri::command]
pub async fn remove_queued_turn(
    manager: State<'_, SessionManager>,
    session_id: String,
    queued_id: String,
) -> Result<(), String> {
    manager.remove_queued_turn(&session_id, &queued_id).await
}

#[tauri::command]
pub async fn steer_queued_turn(
    manager: State<'_, SessionManager>,
    session_id: String,
    queued_id: String,
) -> Result<(), String> {
    manager.steer_queued_turn(&session_id, &queued_id).await
}

#[tauri::command]
pub async fn set_follow_up_queue_mode(
    manager: State<'_, SessionManager>,
    session_id: String,
    mode: String,
) -> Result<(), String> {
    manager
        .set_follow_up_queue_mode(&session_id, &mode)
        .await
}

#[tauri::command]
pub fn session_queue(
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<Vec<QueuedTurn>, String> {
    Ok(manager.session_queue(&session_id))
}

#[tauri::command]
pub async fn interrupt_turn(
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<(), String> {
    manager.interrupt_turn(&session_id).await
}

#[tauri::command]
pub async fn answer_prompt(
    manager: State<'_, SessionManager>,
    session_id: String,
    prompt_id: String,
    answer: PromptAnswer,
) -> Result<(), String> {
    manager.answer_prompt(&session_id, &prompt_id, answer).await
}

#[tauri::command]
pub async fn stop_session(
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<(), String> {
    manager.stop_session(&session_id).await
}

/// 上滚再取一页更早的回合，并返回替换后的整段日志。
#[tauri::command]
pub async fn load_older_history(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<crate::models::OlderHistory, String> {
    manager.load_older_history(&store, &session_id).await
}

/// 拉取会话完整事件日志（切换会话 / 重连时恢复时间线）。
#[tauri::command]
pub async fn get_session_events(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<Vec<SessionEvent>, String> {
    manager.ensure_events(&store, &session_id).await
}
