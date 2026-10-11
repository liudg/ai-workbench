//! AI 工作台 —— Tauri 应用入口。
//!
//! 模块划分：
//! - `models` / `encoding`     共享协议与子进程编码
//! - `features::projects`      项目列表持久化
//! - `features::sessions`      会话生命周期 / 事件日志 / 前端推送
//! - `features::agents`        多 Agent 适配层（公开契约；CLI 实现私有）
//! - `features::images`        时间线本机图片
//! - `features::ipc`           前端 invoke 入口
//! - `tray`                    系统托盘与常驻后台

mod encoding;
mod features;
mod models;
mod tray;

use tauri::Manager;

use features::projects::ProjectStore;
use features::sessions::SessionManager;

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
            let store =
                ProjectStore::load(&data_dir).map_err(|e| format!("加载项目列表失败: {e}"))?;
            app.manage(store);
            app.manage(SessionManager::new(app.handle().clone(), &data_dir));
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
            features::ipc::projects::list_projects,
            features::ipc::projects::create_project,
            features::ipc::projects::import_project,
            features::ipc::projects::remove_project,
            features::ipc::sessions::list_sessions,
            features::ipc::sessions::fork_session,
            features::ipc::sessions::rename_session,
            features::ipc::sessions::set_session_archived,
            features::ipc::sessions::delete_session,
            features::ipc::sessions::create_session,
            features::ipc::sessions::set_session_agent,
            features::ipc::sessions::set_session_access,
            features::ipc::sessions::session_permission_menu,
            features::ipc::agents::list_agent_installations,
            features::ipc::agents::update_agent,
            features::ipc::agents::agent_profiles,
            features::ipc::sessions::cached_agent_catalogs,
            features::ipc::sessions::agent_catalog,
            features::ipc::sessions::set_session_tuning,
            features::ipc::sessions::set_collaboration_mode,
            features::ipc::sessions::review_targets,
            features::ipc::sessions::start_review,
            features::ipc::sessions::send_message,
            features::ipc::sessions::update_queued_turn,
            features::ipc::sessions::remove_queued_turn,
            features::ipc::sessions::session_queue,
            features::ipc::sessions::interrupt_turn,
            features::ipc::sessions::answer_prompt,
            features::ipc::sessions::stop_session,
            features::ipc::sessions::get_session_events,
            features::ipc::sessions::load_older_history,
            features::images::prepare_chat_image,
            features::images::stage_chat_image,
            features::preview::read_preview_file,
            features::preview::browser::prepare_browser_file,
            features::preview::browser::browser_show,
            features::preview::browser::browser_bounds,
            features::preview::browser::browser_hide,
            features::preview::browser::browser_reload,
            features::preview::browser::browser_annotate,
            features::preview::browser::browser_page_title,
            features::preview::browser::browser_annotate_state,
            features::preview::browser::browser_annotation_submit,
            features::preview::browser::browser_open_external,
            features::preview::browser::browser_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
