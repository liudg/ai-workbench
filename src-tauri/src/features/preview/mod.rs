//! 文件预览。只读文本。相对路径相对项目目录，绝对路径按用户打开的位置读取。
//! 打不开时返回找不到、没有权限或不是文件，不再用「只能预览当前项目」拦住项目外的文件。
//! HTML 另走内置浏览器（`browser`），不经过某个 Agent。
//!
//! 工作区目录按一层一层列，不设全局文件上限。路径索引在后台建，遵守 `.gitignore`
//! （含嵌套规则和全局排除）。`.git`、`node_modules`、`target`、`dist`、`Library`、
//! `Temp` 仍然跳过。文件名筛选不读正文；内容搜索单独打开文件。

mod open_with;

pub(crate) mod browser;

use std::path::PathBuf;

use tauri::State;

use crate::features::projects::ProjectStore;
use crate::features::sessions::SessionManager;
use aiwb_core::models::strip_verbatim_prefix;

fn project_root(
    store: &ProjectStore,
    manager: &SessionManager,
    project_id: &str,
    session_id: Option<&str>,
) -> Result<PathBuf, String> {
    let project = store
        .get(project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    manager.work_root(&project, session_id)
}

use aiwb_files::{
    filter_paths, list_dir_at, quick_open_indexed, read_image_at, read_preview_at,
    resolve_preview_file, search_blocking, FilterHub, IndexHub, IndexedPaths, PathFilter,
    PreviewDocument, PreviewImage, SearchOutput, TreeEntry, QUICK_OPEN_LIMIT,
};

#[tauri::command]
pub async fn read_preview_file(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    project_id: String,
    path: String,
    session_id: Option<String>,
) -> Result<PreviewDocument, String> {
    let root = project_root(&store, &manager, &project_id, session_id.as_deref())?;
    tokio::task::spawn_blocking(move || read_preview_at(&root, &path))
        .await
        .map_err(|err| format!("无法读取文件: {err}"))?
}

#[tauri::command]
pub async fn read_preview_image(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    project_id: String,
    path: String,
    session_id: Option<String>,
) -> Result<PreviewImage, String> {
    let root = project_root(&store, &manager, &project_id, session_id.as_deref())?;
    tokio::task::spawn_blocking(move || read_image_at(&root, &path))
        .await
        .map_err(|err| format!("无法读取图片: {err}"))?
}

#[tauri::command]
pub fn open_project_file(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    project_id: String,
    path: String,
    mode: Option<String>,
    session_id: Option<String>,
) -> Result<(), String> {
    let root = project_root(&store, &manager, &project_id, session_id.as_deref())?;
    open_at(&root, &path, mode.as_deref())
}

/// 同 [`open_project_file`]，目录由调用方给出。任务视图的工作目录在 daemon 里，前端直接带过来。
#[tauri::command]
pub fn open_path(root: String, path: String, mode: Option<String>) -> Result<(), String> {
    open_at(&PathBuf::from(root), &path, mode.as_deref())
}

fn open_at(root: &std::path::Path, path: &str, mode: Option<&str>) -> Result<(), String> {
    let full = resolve_preview_file(root, path)?;
    let shown = strip_verbatim_prefix(&full.to_string_lossy());
    let resolved = open_with::resolve_open_mode(mode, open_with::choose_app_supported())
        .map_err(str::to_string)?;
    open_with::open_resolved(&shown, resolved)
}

#[tauri::command]
pub fn file_open_capabilities() -> open_with::FileOpenCapabilities {
    open_with::FileOpenCapabilities {
        choose_app: open_with::choose_app_supported(),
    }
}

#[tauri::command]
pub async fn list_project_dir(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    project_id: String,
    path: String,
    session_id: Option<String>,
) -> Result<Vec<TreeEntry>, String> {
    let root = project_root(&store, &manager, &project_id, session_id.as_deref())?;
    tokio::task::spawn_blocking(move || list_dir_at(&root, &path))
        .await
        .map_err(|err| format!("无法读取目录: {err}"))?
}

#[tauri::command]
pub async fn filter_project_paths(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    hub: State<'_, FilterHub>,
    indexes: State<'_, IndexHub>,
    project_id: String,
    query: String,
    session_id: Option<String>,
) -> Result<PathFilter, String> {
    let root = project_root(&store, &manager, &project_id, session_id.as_deref())?;
    let filters = hub.fork();
    let indexes = indexes.fork();
    tokio::task::spawn_blocking(move || filter_paths(&filters, &indexes, &project_id, root, &query))
        .await
        .map_err(|err| format!("无法筛选文件: {err}"))
}

#[tauri::command]
pub async fn warm_project_index(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    hub: State<'_, IndexHub>,
    project_id: String,
    session_id: Option<String>,
) -> Result<(), String> {
    let root = project_root(&store, &manager, &project_id, session_id.as_deref())?;
    hub.warm_root(root);
    Ok(())
}

#[tauri::command]
pub async fn quick_open_files(
    store: State<'_, ProjectStore>,
    hub: State<'_, IndexHub>,
    project_id: String,
    query: String,
) -> Result<IndexedPaths, String> {
    let project = store
        .get(&project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    let root = PathBuf::from(&project.path);
    let hub = hub.fork();
    tokio::task::spawn_blocking(move || quick_open_indexed(&hub, root, &query, QUICK_OPEN_LIMIT))
        .await
        .map_err(|err| format!("无法列出文件: {err}"))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn search_project_files(
    store: State<'_, ProjectStore>,
    manager: State<'_, SessionManager>,
    hub: State<'_, IndexHub>,
    project_id: String,
    query: String,
    mask: String,
    search_id: u64,
    session_id: Option<String>,
) -> Result<SearchOutput, String> {
    let root = project_root(&store, &manager, &project_id, session_id.as_deref())?;
    let hub = hub.fork();
    tokio::task::spawn_blocking(move || search_blocking(&hub, root, &query, &mask, search_id))
        .await
        .map_err(|err| format!("搜索失败: {err}"))
}
