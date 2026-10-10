//! 会话命令。模型目录、调参和回答提问都转给当前会话的适配器。

use tauri::State;

use crate::features::projects::ProjectStore;
use crate::features::sessions::SessionManager;
use crate::models::*;

#[tauri::command]
pub async fn list_sessions(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    project_id: String,
) -> Result<Vec<Session>, String> {
    Ok(manager.sessions_for_sidebar(&store, &project_id).await)
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
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<AgentCatalog, String> {
    manager.agent_catalog(&session_id).await
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
pub async fn send_message(
    manager: State<'_, SessionManager>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("消息不能为空".into());
    }
    manager.send_message(&session_id, text).await
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
