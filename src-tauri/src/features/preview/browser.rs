//! 预览面板里的内置浏览器。跟具体 Agent 无关。
//! 子 webview 承载页面，地址栏和按钮留在主界面。

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

use super::resolve_preview_file;
use crate::features::projects::ProjectStore;
use crate::models::strip_verbatim_prefix;

const LABEL: &str = "preview-browser";
const EVENT: &str = "preview-browser";

#[derive(Debug, Clone, Serialize)]
pub struct BrowserFile {
    pub display: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
struct BrowserNotice {
    kind: String,
    value: String,
}

fn host_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn display_file_address(path: &Path) -> String {
    strip_verbatim_prefix(&path.to_string_lossy()).replace('\\', "/")
}

pub fn navigation_target(raw: &str) -> Result<Url, String> {
    let text = raw.trim();
    if text.is_empty() || text.chars().any(char::is_control) {
        return Err("无法打开此地址".into());
    }
    if text.eq_ignore_ascii_case("about:blank") {
        return "about:blank"
            .parse()
            .map_err(|_| "无法打开此地址".to_string());
    }
    let url: Url = text.parse().map_err(|_| "无法打开此地址".to_string())?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err("无法打开此地址".into()),
    }
}

pub fn external_open_target(raw: &str) -> Result<String, String> {
    let text = raw.trim();
    if text.is_empty() || text.chars().any(char::is_control) {
        return Err("无法在外部浏览器中打开".into());
    }
    let lower = text.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        navigation_target(text)?;
        return Ok(text.to_string());
    }
    let path = text.replace('/', "\\");
    let as_path = Path::new(&path);
    if as_path.is_absolute() && as_path.is_file() {
        return Ok(path);
    }
    Err("无法在外部浏览器中打开".into())
}

#[tauri::command]
pub fn prepare_browser_file(
    app: AppHandle,
    store: tauri::State<'_, ProjectStore>,
    project_id: String,
    path: String,
) -> Result<BrowserFile, String> {
    let project = store
        .get(&project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    let root = Path::new(&project.path);
    let full = resolve_preview_file(root, &path)?;
    let root_real = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    app.asset_protocol_scope()
        .allow_directory(&root_real, true)
        .map_err(|err| format!("无法打开此地址: {err}"))?;
    let main = app.get_webview_window("main").ok_or("没有主窗口")?;
    let url = main
        .convert_file_src(&full, None)
        .map_err(|err| format!("无法打开此地址: {err}"))?;
    Ok(BrowserFile {
        display: display_file_address(&full),
        url,
    })
}

#[tauri::command]
pub async fn browser_show(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let target = navigation_target(&url)?;
    show_browser(app, target, x, y, width, height)
}

#[tauri::command]
pub async fn browser_bounds(app: AppHandle, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let _guard = host_lock().lock().map_err(|_| "浏览器正忙".to_string())?;
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    place(&webview, x, y, width, height)
}

#[tauri::command]
pub async fn browser_hide(app: AppHandle) -> Result<(), String> {
    let _guard = host_lock().lock().map_err(|_| "浏览器正忙".to_string())?;
    if let Some(webview) = app.get_webview(LABEL) {
        webview.hide().map_err(|err| format!("无法隐藏浏览器: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_reload(app: AppHandle) -> Result<(), String> {
    let _guard = host_lock().lock().map_err(|_| "浏览器正忙".to_string())?;
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    webview
        .reload()
        .map_err(|err| format!("无法刷新页面: {err}"))
}

#[tauri::command]
pub async fn browser_annotate(app: AppHandle, on: bool) -> Result<(), String> {
    let _guard = host_lock().lock().map_err(|_| "浏览器正忙".to_string())?;
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    let script = if on {
        r#"(function(){var root=document.documentElement;if(!root)return;root.setAttribute("data-aw-annotate","1");if(document.getElementById("aw-annotate-style"))return;var style=document.createElement("style");style.id="aw-annotate-style";style.textContent="html[data-aw-annotate='1'],html[data-aw-annotate='1'] *{cursor:crosshair !important}";(document.head||root).appendChild(style);})();"#
    } else {
        r#"(function(){var root=document.documentElement;if(!root)return;root.removeAttribute("data-aw-annotate");var old=document.getElementById("aw-annotate-style");if(old)old.remove();})();"#
    };
    webview
        .eval(script)
        .map_err(|err| format!("无法切换批注: {err}"))
}

#[tauri::command]
pub async fn browser_open_external(target: String) -> Result<(), String> {
    let target = external_open_target(&target)?;
    shell_open(&target)
}

#[tauri::command]
pub async fn browser_close(app: AppHandle) -> Result<(), String> {
    let _guard = host_lock().lock().map_err(|_| "浏览器正忙".to_string())?;
    if let Some(webview) = app.get_webview(LABEL) {
        webview
            .close()
            .map_err(|err| format!("无法关闭浏览器: {err}"))?;
    }
    Ok(())
}

fn show_browser(app: AppHandle, url: Url, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let _guard = host_lock().lock().map_err(|_| "浏览器正忙".to_string())?;
    if width < 8.0 || height < 8.0 {
        if let Some(webview) = app.get_webview(LABEL) {
            webview.hide().map_err(|err| format!("无法隐藏浏览器: {err}"))?;
        }
        return Ok(());
    }
    if let Some(webview) = app.get_webview(LABEL) {
        place(&webview, x, y, width, height)?;
        let current = webview.url().ok();
        if current.as_ref() != Some(&url) {
            webview
                .navigate(url)
                .map_err(|err| format!("无法打开此地址: {err}"))?;
        }
        webview.show().map_err(|err| format!("无法显示浏览器: {err}"))?;
        return Ok(());
    }
    let window = app.get_webview_window("main").ok_or("没有主窗口")?;
    let window = window.as_ref().window();
    let app_for_title = app.clone();
    let app_for_load = app.clone();
    let builder = tauri::webview::WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .on_document_title_changed(move |_webview, title| {
            let _ = app_for_title.emit(
                EVENT,
                BrowserNotice {
                    kind: "title".into(),
                    value: title,
                },
            );
        })
        .on_page_load(move |_webview, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            let _ = app_for_load.emit(
                EVENT,
                BrowserNotice {
                    kind: "load".into(),
                    value: payload.url().to_string(),
                },
            );
        })
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny)
        .on_navigation(|next| matches!(next.scheme(), "http" | "https" | "about"));
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|err| format!("无法打开内置浏览器: {err}"))?;
    webview.show().ok();
    Ok(())
}

fn place(
    webview: &tauri::Webview,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if width < 8.0 || height < 8.0 {
        webview.hide().map_err(|err| format!("无法隐藏浏览器: {err}"))?;
        return Ok(());
    }
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|err| format!("无法移动浏览器: {err}"))?;
    webview
        .set_size(LogicalSize::new(width, height))
        .map_err(|err| format!("无法调整浏览器: {err}"))?;
    Ok(())
}

#[cfg(windows)]
fn shell_open(target: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    let op: Vec<u16> = OsStr::new("open").encode_wide().chain(Some(0)).collect();
    let file: Vec<u16> = OsStr::new(target).encode_wide().chain(Some(0)).collect();
    let code = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if code <= 32 {
        return Err("无法在外部浏览器中打开".into());
    }
    Ok(())
}

#[cfg(windows)]
extern "system" {
    fn ShellExecuteW(
        hwnd: *mut std::ffi::c_void,
        operation: *const u16,
        file: *const u16,
        params: *const u16,
        dir: *const u16,
        show: i32,
    ) -> isize;
}

#[cfg(not(windows))]
fn shell_open(_target: &str) -> Result<(), String> {
    Err("无法在外部浏览器中打开".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_rejects_scripts() {
        assert!(navigation_target("https://example.com/a").is_ok());
        assert!(navigation_target("http://127.0.0.1:9").is_ok());
        assert!(navigation_target("about:blank").is_ok());
        assert!(navigation_target("javascript:alert(1)").is_err());
        assert!(navigation_target("file:///C:/secret.html").is_err());
        assert!(navigation_target("  ").is_err());
    }

    #[test]
    fn external_target_keeps_web_urls() {
        assert_eq!(
            external_open_target(" https://example.com ").unwrap(),
            "https://example.com"
        );
        assert!(external_open_target("javascript:alert(1)").is_err());
        assert!(external_open_target("not a path").is_err());
    }

    #[test]
    fn file_address_uses_forward_slashes() {
        let path = Path::new(r"C:\Users\admin\Documents\Playground\tiger.html");
        assert_eq!(
            display_file_address(path),
            "C:/Users/admin/Documents/Playground/tiger.html"
        );
    }
}
