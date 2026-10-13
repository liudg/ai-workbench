//! 项目命令。移除项目时先停掉该项目下已打开的会话。

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};

use crate::features::agents::group_projects;
use crate::features::projects::{self, ProjectStore};
use crate::features::sessions::SessionManager;
use crate::models::*;

/// 前端事件名：项目列表发生变化
pub const EVT_PROJECTS_CHANGED: &str = "projects-changed";

#[derive(Debug, Serialize)]
pub struct CreateProjectResult {
    pub project: Project,
    /// 非致命问题（如 git init 失败）
    pub warning: Option<String>,
}

fn notify_projects_changed<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(EVT_PROJECTS_CHANGED, ());
}

fn ensure_unlisted(store: &ProjectStore, dir: &str) -> Result<(), String> {
    if store.find_by_path(dir).is_some() {
        Err("该目录已在项目列表中".into())
    } else {
        Ok(())
    }
}

fn publish<R: Runtime>(
    app: &AppHandle<R>,
    store: &ProjectStore,
    project: Project,
) -> Result<Project, String> {
    store.add(project.clone())?;
    notify_projects_changed(app);
    Ok(project)
}

/// 侧边栏项目只来自工作台 projects.json，不扫描 Agent 会话目录。
#[tauri::command]
pub fn list_projects(store: State<'_, ProjectStore>) -> Result<Vec<Project>, String> {
    Ok(group_projects(&store.list()))
}

/// 新建项目：在 parent_dir 下创建目录 + 可选 git init。
#[tauri::command]
pub fn create_project<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, ProjectStore>,
    name: String,
    parent_dir: String,
    default_agent: AgentKind,
    init_git: bool,
) -> Result<CreateProjectResult, String> {
    let (dir, warning) = projects::create_project_dir(&parent_dir, &name, init_git)?;
    ensure_unlisted(&store, &dir)?;
    let now = now_millis();
    let project = publish(
        &app,
        &store,
        Project {
            id: new_id(),
            name: name.trim().to_string(),
            path: dir,
            default_agent,
            created_at: now,
            updated_at: now,
            external: false,
        },
    )?;
    Ok(CreateProjectResult { project, warning })
}

/// 导入已有目录作为工作台项目。只写入 projects.json，不改 Agent 的会话存储。
#[tauri::command]
pub fn import_project<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, ProjectStore>,
    path: String,
    name: Option<String>,
    default_agent: AgentKind,
) -> Result<Project, String> {
    let (dir, inferred_name) = projects::normalize_import_dir(&path)?;
    ensure_unlisted(&store, &dir)?;
    let now = now_millis();
    publish(
        &app,
        &store,
        Project {
            id: new_id(),
            name: name
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty())
                .unwrap_or(inferred_name),
            path: dir,
            default_agent,
            created_at: now,
            updated_at: now,
            external: false,
        },
    )
}

/// 项目目录是否为 git 工作区。探测失败时返回 git 的原文，而不是当成仓库。
#[tauri::command]
pub async fn project_is_git(
    store: State<'_, ProjectStore>,
    project_id: String,
) -> Result<bool, String> {
    let project = store
        .get(&project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    let root = PathBuf::from(project.path);
    tokio::task::spawn_blocking(move || crate::features::git::inside_work_tree(&root))
        .await
        .map_err(|err| format!("无法确认是否为 git 仓库: {err}"))?
}

/// 从工作台列表移除项目（不删除磁盘目录，也不删除 Agent 的会话记录）。
#[tauri::command]
pub async fn remove_project<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    id: String,
) -> Result<(), String> {
    if id.starts_with("dir:") && store.get(&id).is_none() {
        return Err("这个目录来自 Agent 会话列表，不能单独移除。".into());
    }
    manager.stop_sessions_of_project(&id).await;
    if store.remove(&id)? {
        notify_projects_changed(&app);
        Ok(())
    } else {
        Err("项目不存在".into())
    }
}
