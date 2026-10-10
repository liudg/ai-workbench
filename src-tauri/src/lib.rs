//! AI 工作台 —— Tauri 应用入口。
//!
//! 模块划分：
//! - `models`          领域模型（IPC 协议）
//! - `project_store`   项目列表持久化
//! - `session_manager` 会话生命周期 / 事件日志 / 前端推送
//! - `agents`          Agent CLI 适配层（Codex 真实进程，Claude Code 仍是桩）
//! - `chat_images`     时间线本机图片：校验后放入 asset 协议
//! - `commands`        前端 invoke 入口
//! - `tray`            系统托盘与常驻后台

mod agents;
mod chat_images;
mod commands;
mod encoding;
mod models;
mod project_store;
mod session_manager;
mod tray;

use tauri::Manager;

use project_store::ProjectStore;
use session_manager::SessionManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
            let store = ProjectStore::load(&data_dir)
                .map_err(|e| format!("加载项目列表失败: {e}"))?;
            app.manage(store);
            app.manage(SessionManager::new(app.handle().clone()));
            tray::setup(app.handle())?;
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
            commands::list_projects,
            commands::create_project,
            commands::import_project,
            commands::remove_project,
            commands::list_sessions,
            commands::create_session,
            commands::set_session_agent,
            commands::set_session_access,
            commands::list_agent_installations,
            commands::update_agent,
            commands::agent_profiles,
            commands::agent_catalog,
            commands::set_session_tuning,
            commands::send_message,
            commands::answer_prompt,
            commands::stop_session,
            commands::get_session_events,
            chat_images::prepare_chat_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
