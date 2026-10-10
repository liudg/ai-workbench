//! 会话命令。模型目录、调参和回答提问都转给当前会话的适配器。

use tauri::State;

use crate::features::projects::ProjectStore;
use crate::features::sessions::{AgentCatalogRefresh, CachedAgentCatalog, SessionManager};
use crate::models::*;

#[tauri::command]
pub async fn list_sessions(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    project_id: String,
    archived: Option<bool>,
) -> Result<Vec<Session>, String> {
    Ok(manager
        .sessions_for_sidebar(&store, &project_id, archived.unwrap_or(false))
        .await)
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

#[tauri::command]
pub async fn delete_session(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<(), String> {
    manager.delete_session(&store, &session_id).await
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
pub fn cached_agent_catalogs(manager: State<'_, SessionManager>) -> Vec<CachedAgentCatalog> {
    manager.cached_catalogs()
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
pub fn set_session_tuning(
    manager: State<'_, SessionManager>,
    session_id: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    manager.set_session_tuning(&session_id, model, effort)
}

#[tauri::command]
pub fn set_session_access(
    manager: State<'_, SessionManager>,
    session_id: String,
    mode: String,
) -> Result<(), String> {
    manager.set_session_access(&session_id, &mode)
}

#[tauri::command]
pub fn set_session_agent(
    manager: State<'_, SessionManager>,
    session_id: String,
    agent: AgentKind,
) -> Result<(), String> {
    manager.set_session_agent(&session_id, agent)
}

#[tauri::command]
pub fn set_collaboration_mode(
    manager: State<'_, SessionManager>,
    session_id: String,
    mode: String,
) -> Result<(), String> {
    manager.set_collaboration_mode(&session_id, &mode)
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
pub async fn revert_turn(
    manager: State<'_, SessionManager>,
    session_id: String,
    turn_id: String,
) -> Result<(), String> {
    manager.revert_turn(&session_id, &turn_id).await
}

#[tauri::command]
pub async fn send_message(
    manager: State<'_, SessionManager>,
    session_id: String,
    text: String,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    let text = text.trim().to_string();
    let images = images.unwrap_or_default();
    if text.is_empty() && images.is_empty() {
        return Err("消息不能为空".into());
    }
    manager.send_message(&session_id, text, images).await
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

/// 拉取会话完整事件日志（切换会话 / 重连时恢复时间线）。
#[tauri::command]
pub async fn get_session_events(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<Vec<SessionEvent>, String> {
    manager.ensure_events(&store, &session_id).await
}
