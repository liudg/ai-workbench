//! AI 工作台 —— Tauri 应用壳。会话、项目、文件都在 daemon（`aiwb-daemon`），这里只做本机能力。
//!
//! 模块划分：
//! - `daemon`                  拉起和连接 daemon
//! - `attention`               订阅注意力，发系统通知、画任务栏角标
//! - `features::images`        时间线本机图片
//! - `features::preview`       用系统程序打开、内置浏览器
//! - `tray`                    系统托盘与常驻后台

mod attention;
mod daemon;
mod features;
mod tray;

use tauri::Manager;

/// WebView2 启动参数：wry 默认的 --disable-features 加上固定 CDP 端口 9222（自验自动化用选择器）。
/// 必须与 tauri.conf.json 主窗口的 additionalBrowserArgs 保持一字不差。
/// 所有构建（含发布版）都开；端口只绑 127.0.0.1，但本机任何进程都能无认证连上。
pub const WEBVIEW2_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=9222";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
            tray::setup(app.handle())?;
            attention::start(app.handle(), data_dir);
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗不退出：隐藏到托盘，后台会话（agent 进程）继续运行；
            // 真正的退出走托盘菜单「退出」。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            daemon::daemon_endpoint,
            features::images::prepare_chat_image,
            features::images::stage_chat_image,
            features::preview::open_path,
            features::preview::reveal_folder,
            features::preview::open_url,
            features::preview::file_open_capabilities,
            features::preview::browser::prepare_browser_path,
            features::preview::browser::browser_show,
            features::preview::browser::browser_hide,
            features::preview::browser::browser_reload,
            features::preview::browser::browser_annotate,
            features::preview::browser::browser_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
