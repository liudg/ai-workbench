//! 应用壳的本机打开：用系统程序打开文件、在资源管理器里打开目录、内置浏览器。
//! 目录由前端带过来，工作目录、项目都在 daemon 里。读文件、目录和搜索走 daemon。

mod open_with;
mod reveal;

pub(crate) mod browser;

use std::path::PathBuf;

use aiwb_core::models::strip_verbatim_prefix;
use aiwb_files::resolve_preview_file;

/// 用系统程序打开 `root` 下的文件。
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

/// 用系统浏览器打开网页。只接 http(s)，别的协议不交给系统。
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|_| "不是有效的网页地址".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("不是有效的网页地址".into());
    }
    browser::open_in_shell(parsed.as_str())
}

#[tauri::command]
pub fn file_open_capabilities() -> open_with::FileOpenCapabilities {
    open_with::FileOpenCapabilities {
        choose_app: open_with::choose_app_supported(),
    }
}

/// 在系统资源管理器中打开一个目录。
#[tauri::command]
pub async fn reveal_folder(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || reveal::reveal_project_folder(&path))
        .await
        .map_err(|_| "无法在资源管理器中打开".to_string())?
}
