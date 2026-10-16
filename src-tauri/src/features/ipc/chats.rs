//! 无项目任务文件夹。目录选择由前端对话框完成，这里只记住并展示。

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime, State};

use crate::features::chats::{documents_dir, TaskFolderStore, TaskFolderView};

pub(crate) fn host_documents<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    documents_dir(app.path().document_dir().ok())
}

#[tauri::command]
pub fn task_folder<R: Runtime>(
    app: AppHandle<R>,
    folders: State<'_, TaskFolderStore>,
) -> Result<TaskFolderView, String> {
    Ok(folders.view(&host_documents(&app)))
}

#[tauri::command]
pub fn set_task_folder<R: Runtime>(
    app: AppHandle<R>,
    folders: State<'_, TaskFolderStore>,
    path: String,
) -> Result<TaskFolderView, String> {
    folders.set_path(&path)?;
    Ok(folders.view(&host_documents(&app)))
}
