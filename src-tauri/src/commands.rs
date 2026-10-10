//! Tauri commands：前端 invoke 的全部入口。
//! 命名规则：参数用 camelCase（与前端 TypeScript 调用保持一致）。

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::models::*;
use crate::project_store::{self, ProjectStore};
use crate::session_manager::SessionManager;

/// 前端事件名：项目列表发生变化
pub const EVT_PROJECTS_CHANGED: &str = "projects-changed";

#[derive(Debug, Serialize)]
pub struct CreateProjectResult {
    pub project: Project,
    /// 非致命问题（如 git init 失败）
    pub warning: Option<String>,
}

fn notify_projects_changed(app: &AppHandle) {
    let _ = app.emit(EVT_PROJECTS_CHANGED, ());
}

// ---------- 项目 ----------

#[tauri::command]
pub fn list_projects(store: State<'_, ProjectStore>) -> Vec<Project> {
    store.list()
}

/// 新建项目：在 parent_dir 下创建目录 + 可选 git init。
#[tauri::command]
pub fn create_project(
    app: AppHandle,
    store: State<'_, ProjectStore>,
    name: String,
    parent_dir: String,
    default_agent: AgentKind,
    init_git: bool,
) -> Result<CreateProjectResult, String> {
    let (dir, warning) = project_store::create_project_dir(&parent_dir, &name, init_git)?;
    if store.find_by_path(&dir).is_some() {
        return Err("该目录已在项目列表中".into());
    }
    let now = now_millis();
    let project = Project {
        id: new_id(),
        name: name.trim().to_string(),
        path: dir,
        default_agent,
        created_at: now,
        updated_at: now,
    };
    store.add(project.clone())?;
    notify_projects_changed(&app);
    Ok(CreateProjectResult { project, warning })
}

/// 导入已有目录作为项目。
#[tauri::command]
pub fn import_project(
    app: AppHandle,
    store: State<'_, ProjectStore>,
    path: String,
    name: Option<String>,
    default_agent: AgentKind,
) -> Result<Project, String> {
    let (dir, inferred_name) = project_store::normalize_import_dir(&path)?;
    if store.find_by_path(&dir).is_some() {
        return Err("该目录已在项目列表中".into());
    }
    let now = now_millis();
    let project = Project {
        id: new_id(),
        name: name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or(inferred_name),
        path: dir,
        default_agent,
        created_at: now,
        updated_at: now,
    };
    store.add(project.clone())?;
    notify_projects_changed(&app);
    Ok(project)
}

/// 从列表移除项目（不删除磁盘目录），并停止其全部会话。
#[tauri::command]
pub async fn remove_project(
    app: AppHandle,
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    id: String,
) -> Result<(), String> {
    manager.stop_sessions_of_project(&id).await;
    if store.remove(&id)? {
        notify_projects_changed(&app);
        Ok(())
    } else {
        Err("项目不存在".into())
    }
}

// ---------- 会话 ----------

#[tauri::command]
pub fn list_sessions(
    manager: State<'_, SessionManager>,
    project_id: String,
) -> Vec<Session> {
    manager.list_sessions(&project_id)
}

/// 创建会话；agent 缺省时用项目默认 Agent。
#[tauri::command]
pub async fn create_session(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    project_id: String,
    agent: Option<AgentKind>,
) -> Result<Session, String> {
    let project = store.get(&project_id).ok_or("项目不存在")?;
    manager
        .create_session(&project, agent.unwrap_or(project.default_agent))
        .await
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
    answer: String,
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
pub fn get_session_events(
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<Vec<SessionEvent>, String> {
    manager.get_events(&session_id)
}
