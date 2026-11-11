//! 预览面板里的内置浏览器。跟具体 Agent 无关。
//! 子 webview 承载页面，地址栏和按钮留在主界面。

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
#[cfg(windows)]
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, Url, WebviewUrl};

use super::resolve_preview_file;
use crate::features::images::stage_image_bytes;
use crate::features::projects::ProjectStore;
use crate::models::{strip_verbatim_prefix, PageAnnotation};

const LABEL: &str = "preview-browser";
const EVENT: &str = "preview-browser";
const PAGE_JS: &str = include_str!("page.js");

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

struct BrowserState {
    url: String,
    hidden: bool,
    bounds: Option<(i32, i32, i32, i32)>,
}

impl Default for BrowserState {
    fn default() -> Self {
        Self {
            url: String::new(),
            hidden: true,
            bounds: None,
        }
    }
}

fn host_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn host_state() -> &'static Mutex<BrowserState> {
    static STATE: OnceLock<Mutex<BrowserState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(BrowserState::default()))
}

static CHANNEL_HOOKED: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static PULLING: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static PULL_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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

pub fn should_navigate(stored: &str, requested: &str, live: Option<&str>) -> bool {
    if urls_equivalent(stored, requested) {
        return false;
    }
    if live.is_some_and(|url| urls_equivalent(url, requested)) {
        return false;
    }
    true
}

fn urls_equivalent(left: &str, right: &str) -> bool {
    fn norm(value: &str) -> String {
        value.trim().trim_end_matches('/').to_string()
    }
    !left.is_empty() && norm(left) == norm(right)
}

#[tauri::command]
pub fn prepare_browser_file(
    app: AppHandle,
    store: tauri::State<'_, ProjectStore>,
    manager: tauri::State<'_, crate::features::sessions::SessionManager>,
    project_id: String,
    path: String,
    session_id: Option<String>,
) -> Result<BrowserFile, String> {
    let root = super::project_root(&store, &manager, &project_id, session_id.as_deref())?;
    let full = resolve_preview_file(&root, &path)?;
    let root_real = root.canonicalize().unwrap_or(root);
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
pub async fn browser_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let _guard = host_lock().lock().map_err(|_| "浏览器正忙".to_string())?;
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    place(&webview, x, y, width, height, false)
}

#[tauri::command]
pub async fn browser_hide(app: AppHandle) -> Result<(), String> {
    let _guard = host_lock().lock().map_err(|_| "浏览器正忙".to_string())?;
    if let Some(webview) = app.get_webview(LABEL) {
        webview
            .hide()
            .map_err(|err| format!("无法隐藏浏览器: {err}"))?;
        if let Ok(mut state) = host_state().lock() {
            state.hidden = true;
        }
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
    let script = format!("window.__awSetAnnotate&&window.__awSetAnnotate({on}, true);");
    let _ = webview.eval(script);
    Ok(())
}

#[tauri::command]
pub fn browser_page_title(app: AppHandle, title: String) {
    emit_title(&app, &title);
}

#[tauri::command]
pub fn browser_annotate_state(app: AppHandle, kind: String, on: bool) {
    if kind == "annotate" || kind == "suspended" {
        emit_flag(&app, &kind, on);
    }
}

#[tauri::command]
pub fn browser_annotation_submit(app: AppHandle, note: PageAnnotation) {
    accept_annotation(app, note);
}

#[tauri::command]
pub async fn browser_open_external(target: String) -> Result<(), String> {
    let target = external_open_target(&target)?;
    shell_open(&target)
}

#[tauri::command]
pub async fn browser_close<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let _guard = host_lock().lock().map_err(|_| "浏览器正忙".to_string())?;
    if let Some(webview) = app.get_webview(LABEL) {
        webview
            .close()
            .map_err(|err| format!("无法关闭浏览器: {err}"))?;
    }
    CHANNEL_HOOKED.store(false, Ordering::SeqCst);
    *host_state().lock().unwrap_or_else(|err| err.into_inner()) = BrowserState::default();
    Ok(())
}

fn show_browser(
    app: AppHandle,
    url: Url,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if width < 8.0 || height < 8.0 {
        return Ok(());
    }
    ensure_page_pull(app.clone());
    let requested = url.to_string();
    let _guard = host_lock().lock().map_err(|_| "浏览器正忙".to_string())?;
    if let Some(webview) = app.get_webview(LABEL) {
        place(&webview, x, y, width, height, true)?;
        let live = webview.url().ok().map(|item| item.to_string());
        let stored = host_state()
            .lock()
            .map(|state| state.url.clone())
            .unwrap_or_default();
        if should_navigate(&stored, &requested, live.as_deref()) {
            webview
                .navigate(url)
                .map_err(|err| format!("无法打开此地址: {err}"))?;
        }
        if let Ok(mut state) = host_state().lock() {
            state.url = requested;
            state.hidden = false;
        }
        webview
            .show()
            .map_err(|err| format!("无法显示浏览器: {err}"))?;
        raise_surface(&webview);
        return Ok(());
    }
    CHANNEL_HOOKED.store(false, Ordering::SeqCst);
    if let Ok(mut state) = host_state().lock() {
        state.url = requested;
        state.hidden = false;
        state.bounds = None;
    }
    let window = app.get_webview_window("main").ok_or("没有主窗口")?;
    let window = window.as_ref().window();
    let app_for_load = app.clone();
    let builder = tauri::webview::WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .background_color(tauri::webview::Color(255, 255, 255, 255))
        .initialization_script(PAGE_JS)
        // 与 tauri.conf.json 主窗口 additionalBrowserArgs 一致：同一数据目录下 WebView2 参数不同会建不出子 webview。
        .additional_browser_args(crate::WEBVIEW2_BROWSER_ARGS)
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
    install_page_channel(&webview, app);
    place(&webview, x, y, width, height, true)?;
    webview.show().ok();
    Ok(())
}

fn place(
    webview: &tauri::Webview,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    always_raise: bool,
) -> Result<(), String> {
    if width < 8.0 || height < 8.0 {
        return Ok(());
    }
    let key = (
        x.round() as i32,
        y.round() as i32,
        width.round() as i32,
        height.round() as i32,
    );
    let (moved, reveal) = {
        let mut state = host_state().lock().unwrap_or_else(|err| err.into_inner());
        let moved = state.bounds != Some(key);
        let reveal = state.hidden;
        if !moved && !reveal && !always_raise {
            return Ok(());
        }
        state.bounds = Some(key);
        state.hidden = false;
        (moved, reveal)
    };
    if moved {
        webview
            .set_position(LogicalPosition::new(x, y))
            .map_err(|err| format!("无法移动浏览器: {err}"))?;
        webview
            .set_size(LogicalSize::new(width, height))
            .map_err(|err| format!("无法调整浏览器: {err}"))?;
    }
    if reveal {
        webview
            .show()
            .map_err(|err| format!("无法显示浏览器: {err}"))?;
    }
    if moved || reveal || always_raise {
        raise_surface(webview);
    }
    Ok(())
}

fn emit_title(app: &AppHandle, title: &str) {
    if title.trim().is_empty() {
        return;
    }
    let _ = app.emit(
        EVENT,
        BrowserNotice {
            kind: "title".into(),
            value: title.to_string(),
        },
    );
}

fn emit_flag(app: &AppHandle, kind: &str, on: bool) {
    let _ = app.emit(
        EVENT,
        BrowserNotice {
            kind: kind.to_string(),
            value: if on { "1" } else { "0" }.to_string(),
        },
    );
}

fn emit_annotation(app: &AppHandle, note: &PageAnnotation) {
    let Ok(value) = serde_json::to_string(note) else {
        return;
    };
    let _ = app.emit(
        EVENT,
        BrowserNotice {
            kind: "annotation".into(),
            value,
        },
    );
}

fn accept_annotation(app: AppHandle, note: PageAnnotation) {
    std::thread::spawn(move || {
        let mut note = normalize_note(note);
        match capture_png(&app) {
            Ok(bytes) => match stage_png(&app, &bytes) {
                Ok(path) => note.screenshot = Some(path),
                Err(_) => note.snapshot_failed = true,
            },
            Err(_) => note.snapshot_failed = true,
        }
        emit_annotation(&app, &note);
    });
}

fn normalize_note(mut note: PageAnnotation) -> PageAnnotation {
    if note.id.trim().is_empty() {
        note.id = uuid::Uuid::new_v4().to_string();
    }
    note.url = note.url.trim().to_string();
    note.selector = clamp_chars(note.selector.trim(), 500);
    note.text = clamp_chars(note.text.trim(), 500);
    note.comment = clamp_chars(note.comment.trim(), 4000);
    note
}

fn clamp_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

fn stage_png(app: &AppHandle, bytes: &[u8]) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("staged-images");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let (_name, path) = stage_image_bytes(&dir, "annotation.png", bytes)?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|err| err.to_string())?;
    Ok(strip_verbatim_prefix(&path.to_string_lossy()))
}

#[cfg(windows)]
fn seen_messages() -> &'static Mutex<Vec<u64>> {
    static SEEN: OnceLock<Mutex<Vec<u64>>> = OnceLock::new();
    SEEN.get_or_init(|| Mutex::new(Vec::new()))
}

#[cfg(any(windows, test))]
fn parse_drained_messages(raw: &str) -> Vec<serde_json::Value> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let value = match value {
        serde_json::Value::String(text) => {
            serde_json::from_str::<serde_json::Value>(&text).unwrap_or(serde_json::Value::Null)
        }
        other => other,
    };
    match value {
        serde_json::Value::Array(items) => items,
        _ => Vec::new(),
    }
}

#[cfg(windows)]
fn claim_message(value: &serde_json::Value) -> bool {
    let Some(mid) = value.get("mid").and_then(|item| item.as_u64()) else {
        return true;
    };
    let mut seen = seen_messages()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    if seen.contains(&mid) {
        return false;
    }
    seen.push(mid);
    if seen.len() > 128 {
        let extra = seen.len() - 128;
        seen.drain(0..extra);
    }
    true
}

#[cfg(windows)]
fn handle_page_payload(app: &AppHandle, raw: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return;
    };
    dispatch_page_message(app, value);
}

#[cfg(windows)]
fn apply_drained(app: &AppHandle, raw: &str) {
    for item in parse_drained_messages(raw) {
        dispatch_page_message(app, item);
    }
}

#[cfg(windows)]
fn dispatch_page_message(app: &AppHandle, value: serde_json::Value) {
    if value.get("channel").and_then(|item| item.as_str()) != Some("aw-browser") {
        return;
    }
    if !claim_message(&value) {
        return;
    }
    let kind = value
        .get("kind")
        .and_then(|item| item.as_str())
        .unwrap_or("");
    match kind {
        "title" => {
            let title = value
                .get("title")
                .and_then(|item| item.as_str())
                .unwrap_or("");
            emit_title(app, title);
        }
        "annotate" | "suspended" => {
            let on = value
                .get("on")
                .and_then(|item| item.as_bool())
                .unwrap_or(false);
            emit_flag(app, kind, on);
        }
        "annotation" => {
            let Some(note) = value.get("note").cloned() else {
                return;
            };
            let Ok(note) = serde_json::from_value::<PageAnnotation>(note) else {
                return;
            };
            accept_annotation(app.clone(), note);
        }
        _ => {}
    }
}

fn ensure_page_pull(app: AppHandle) {
    #[cfg(not(windows))]
    {
        let _ = app;
    }
    #[cfg(windows)]
    {
        static STARTED: OnceLock<()> = OnceLock::new();
        STARTED.get_or_init(|| {
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(120));
                let hidden = host_state()
                    .lock()
                    .map(|state| state.hidden)
                    .unwrap_or(true);
                if hidden {
                    continue;
                }
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_millis() as u64)
                    .unwrap_or(0);
                if PULLING.load(Ordering::SeqCst) {
                    let started = PULL_AT.load(Ordering::SeqCst);
                    if now.saturating_sub(started) < 2_000 {
                        continue;
                    }
                }
                PULL_AT.store(now, Ordering::SeqCst);
                PULLING.store(true, Ordering::SeqCst);
                let Some(webview) = app.get_webview(LABEL) else {
                    PULLING.store(false, Ordering::SeqCst);
                    continue;
                };
                let app_for_pull = app.clone();
                let queued = webview.with_webview(move |platform| {
                    if start_pull(platform, app_for_pull).is_err() {
                        PULLING.store(false, Ordering::SeqCst);
                    }
                });
                if queued.is_err() {
                    PULLING.store(false, Ordering::SeqCst);
                }
            });
        });
    }
}

#[cfg(windows)]
fn start_pull(platform: tauri::webview::PlatformWebview, app: AppHandle) -> Result<(), String> {
    use webview2_com::ExecuteScriptCompletedHandler;
    use windows::core::HSTRING;
    let controller = platform.controller();
    let core = unsafe { controller.CoreWebView2() }.map_err(|err| err.to_string())?;
    let script = HSTRING::from("window.__awDrain?window.__awDrain():[]");
    let handler = ExecuteScriptCompletedHandler::create(Box::new(move |hr, raw| {
        PULLING.store(false, Ordering::SeqCst);
        if hr.is_ok() {
            apply_drained(&app, &raw);
        }
        Ok(())
    }));
    unsafe { core.ExecuteScript(&script, &handler) }.map_err(|err| err.to_string())
}

fn install_page_channel(webview: &tauri::Webview, app: AppHandle) {
    #[cfg(windows)]
    {
        if CHANNEL_HOOKED.swap(true, Ordering::SeqCst) {
            return;
        }
        let hooked = webview.with_webview(move |platform| attach_channel(platform, app));
        if hooked.is_err() {
            CHANNEL_HOOKED.store(false, Ordering::SeqCst);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, app);
    }
}

fn raise_surface(webview: &tauri::Webview) {
    let _ = webview.with_webview(|platform| {
        #[cfg(windows)]
        raise_platform(platform);
        #[cfg(not(windows))]
        let _ = platform;
    });
}

fn capture_png(app: &AppHandle) -> Result<Vec<u8>, String> {
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("截图不可用".into())
    }
    #[cfg(windows)]
    {
        let webview = app.get_webview(LABEL).ok_or("没有浏览器")?;
        let (tx, rx) = std::sync::mpsc::channel();
        webview
            .with_webview(move |platform| {
                if let Err(err) = start_capture(platform, tx.clone()) {
                    let _ = tx.send(Err(err));
                }
            })
            .map_err(|err| err.to_string())?;
        rx.recv_timeout(Duration::from_secs(4))
            .map_err(|_| "截图超时".to_string())?
    }
}

#[cfg(windows)]
fn attach_channel(platform: tauri::webview::PlatformWebview, app: AppHandle) {
    use webview2_com::WebMessageReceivedEventHandler;
    let controller = platform.controller();
    let Ok(webview) = (unsafe { controller.CoreWebView2() }) else {
        return;
    };
    let handler = WebMessageReceivedEventHandler::create(Box::new(move |_view, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut raw = windows::core::PWSTR::null();
        if unsafe { args.WebMessageAsJson(&mut raw) }.is_err() {
            return Ok(());
        }
        let text = take_pwstr(raw);
        handle_page_payload(&app, &text);
        Ok(())
    }));
    let mut token = 0i64;
    let _ = unsafe { webview.add_WebMessageReceived(&handler, &mut token) };
    raise_platform(platform);
}

#[cfg(windows)]
fn raise_platform(platform: tauri::webview::PlatformWebview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller2, COREWEBVIEW2_COLOR,
    };
    use windows::core::Interface;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    };
    let controller = platform.controller();
    if let Ok(controller2) = controller.cast::<ICoreWebView2Controller2>() {
        let _ = unsafe {
            controller2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                A: 255,
                R: 255,
                G: 255,
                B: 255,
            })
        };
    }
    let _ = unsafe { controller.SetIsVisible(true) };
    let _ = unsafe { controller.NotifyParentWindowPositionChanged() };
    let mut hwnd = HWND::default();
    if unsafe { controller.ParentWindow(&mut hwnd) }.is_ok() {
        let _ = unsafe {
            SetWindowPos(
                hwnd,
                Some(HWND_TOP),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
        };
    }
}

#[cfg(windows)]
fn start_capture(
    platform: tauri::webview::PlatformWebview,
    tx: std::sync::mpsc::Sender<Result<Vec<u8>, String>>,
) -> Result<(), String> {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    let controller = platform.controller();
    let core = unsafe { controller.CoreWebView2() }.map_err(|err| err.to_string())?;
    let stream = unsafe { CreateStreamOnHGlobal(HGLOBAL(std::ptr::null_mut()), true) }
        .map_err(|err| err.to_string())?;
    let stream_for_cb = stream.clone();
    let tx_cb = tx.clone();
    let handler = CapturePreviewCompletedHandler::create(Box::new(move |hr| {
        let result = match hr {
            Ok(()) => read_png(&stream_for_cb),
            Err(err) => Err(err.to_string()),
        };
        let _ = tx_cb.send(result);
        Ok(())
    }));
    unsafe {
        core.CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            &stream,
            &handler,
        )
    }
    .map_err(|err| err.to_string())?;
    Ok(())
}

#[cfg(windows)]
fn read_png(stream: &windows::Win32::System::Com::IStream) -> Result<Vec<u8>, String> {
    use windows::Win32::System::Com::{STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};
    unsafe {
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|err| err.to_string())?;
        let mut stat = STATSTG::default();
        stream
            .Stat(&mut stat, STATFLAG_NONAME)
            .map_err(|err| err.to_string())?;
        let size = usize::try_from(stat.cbSize).map_err(|_| "截图为空".to_string())?;
        if !(8..=20 * 1024 * 1024).contains(&size) {
            return Err("截图为空".into());
        }
        let mut buf = vec![0u8; size];
        let mut read = 0u32;
        stream
            .Read(buf.as_mut_ptr().cast(), size as u32, Some(&mut read))
            .ok()
            .map_err(|err| err.to_string())?;
        buf.truncate(read as usize);
        if buf.len() < 8 || buf[0..8] != *b"\x89PNG\r\n\x1a\n" {
            return Err("截图不是 PNG".into());
        }
        Ok(buf)
    }
}

#[cfg(windows)]
fn take_pwstr(ptr: windows::core::PWSTR) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let text = unsafe { ptr.to_string() }.unwrap_or_default();
    unsafe {
        windows::Win32::System::Com::CoTaskMemFree(Some(ptr.as_ptr().cast()));
    }
    text
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
fn shell_open(target: &str) -> Result<(), String> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(target)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|_| "无法在外部浏览器中打开".to_string())
}

pub(crate) fn open_in_shell(target: &str) -> Result<(), String> {
    shell_open(target).map_err(|_| "无法在外部打开".to_string())
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

    #[test]
    fn drained_script_result_is_a_message_list() {
        let raw = r#"[{"channel":"aw-browser","kind":"title","title":"虎豹自行车 28","mid":1}]"#;
        let items = parse_drained_messages(raw);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["title"], "虎豹自行车 28");
        let wrapped = serde_json::to_string(raw).unwrap();
        assert_eq!(parse_drained_messages(&wrapped).len(), 1);
        assert!(parse_drained_messages("null").is_empty());
    }

    #[test]
    fn same_address_does_not_navigate_again() {
        assert!(!should_navigate(
            "https://example.com/a",
            "https://example.com/a/",
            None
        ));
        assert!(!should_navigate(
            "https://example.com/a",
            "https://example.com/b",
            Some("https://example.com/b")
        ));
        assert!(should_navigate(
            "https://example.com/a",
            "https://example.com/b",
            Some("https://example.com/a")
        ));
        assert!(should_navigate("", "https://example.com/a", None));
    }
}
