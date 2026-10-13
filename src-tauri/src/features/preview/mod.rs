//! 文件预览。只读文本。相对路径相对项目目录，绝对路径按用户打开的位置读取。
//! 打不开时返回找不到、没有权限或不是文件，不再用「只能预览当前项目」拦住项目外的文件。
//! HTML 另走内置浏览器（`browser`），不经过某个 Agent。
//!
//! 工作区目录按一层一层列，不设全局文件上限。`.git`、`node_modules`、`target`、
//! `dist`、`Library`、`Temp` 不进目录树，也不进全文搜索；其余目录和文件都列出来。

mod image;
mod index;
mod path;
mod read;

pub mod search;
pub mod tree;

pub(crate) mod browser;

use std::path::{Path, PathBuf};

use tauri::State;

use crate::features::projects::ProjectStore;
use crate::models::strip_verbatim_prefix;

pub use image::{read_image_at, PreviewImage};
pub use path::resolve_preview_file;
pub(crate) use path::skip_tree_dir;
pub use read::{read_preview_at, PreviewDocument};

#[tauri::command]
pub async fn read_preview_file(
    store: State<'_, ProjectStore>,
    project_id: String,
    path: String,
) -> Result<PreviewDocument, String> {
    let project = store
        .get(&project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    let root = PathBuf::from(&project.path);
    tokio::task::spawn_blocking(move || read_preview_at(&root, &path))
        .await
        .map_err(|err| format!("无法读取文件: {err}"))?
}

#[tauri::command]
pub async fn read_preview_image(
    store: State<'_, ProjectStore>,
    project_id: String,
    path: String,
) -> Result<PreviewImage, String> {
    let project = store
        .get(&project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    let root = PathBuf::from(&project.path);
    tokio::task::spawn_blocking(move || read_image_at(&root, &path))
        .await
        .map_err(|err| format!("无法读取图片: {err}"))?
}

#[tauri::command]
pub fn open_project_file(
    store: State<'_, ProjectStore>,
    project_id: String,
    path: String,
) -> Result<(), String> {
    let project = store
        .get(&project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    let full = resolve_preview_file(Path::new(&project.path), &path)?;
    let shown = strip_verbatim_prefix(&full.to_string_lossy());
    browser::open_in_shell(&shown)
}
