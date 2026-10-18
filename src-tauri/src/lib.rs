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
//! - `dev_bridge`              网页预览用的本机 HTTP 入口（`dev-bridge` feature）

mod encoding;
mod features;
mod models;
mod tray;

#[cfg(feature = "dev-bridge")]
pub mod dev_bridge;

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, Runtime};

use features::chats::TaskFolderStore;
use features::projects::ProjectStore;
use features::sessions::{EventEmitter, SessionManager};

/// 与窗口无关的命令。桌面版和网页预览的 dev bridge 共用这一份。
macro_rules! workbench_handler {
    ($($extra:path),* $(,)?) => {
        tauri::generate_handler![
            $crate::features::ipc::projects::list_projects,
            $crate::features::ipc::chats::task_folder,
            $crate::features::ipc::chats::set_task_folder,
            $crate::features::ipc::projects::create_project,
            $crate::features::ipc::projects::import_project,
            $crate::features::ipc::projects::update_project,
            $crate::features::ipc::projects::open_project_folder,
            $crate::features::ipc::projects::remove_project,
            $crate::features::ipc::projects::project_is_git,
            $crate::features::ipc::projects::project_has_commit,
            $crate::features::ipc::projects::project_branch,
            $crate::features::ipc::projects::project_git_branches,
            $crate::features::ipc::projects::project_checkout_branch,
            $crate::features::ipc::projects::project_create_branch,
            $crate::features::ipc::sessions::list_sessions,
            $crate::features::ipc::sessions::fork_session,
            $crate::features::ipc::sessions::rename_session,
            $crate::features::ipc::sessions::set_session_archived,
            $crate::features::ipc::sessions::delete_session,
            $crate::features::ipc::sessions::session_worktree_delete_preview,
            $crate::features::ipc::sessions::create_session,
            $crate::features::ipc::sessions::create_session_and_send,
            $crate::features::ipc::sessions::cancel_session_start,
            $crate::features::ipc::sessions::discard_unsent_session,
            $crate::features::ipc::sessions::cached_agent_catalog,
            $crate::features::ipc::sessions::agent_permission_menu,
            $crate::features::ipc::sessions::set_session_access,
            $crate::features::ipc::sessions::session_permission_menu,
            $crate::features::ipc::agents::list_agent_installations,
            $crate::features::ipc::agents::update_agent,
            $crate::features::ipc::agents::agent_profiles,
            $crate::features::ipc::agents::subscription_usage,
            $crate::features::ipc::mcp::mcp_surfaces,
            $crate::features::ipc::mcp::mcp_list,
            $crate::features::ipc::mcp::mcp_add,
            $crate::features::ipc::mcp::mcp_remove,
            $crate::features::ipc::mcp::mcp_login,
            $crate::features::ipc::mcp::mcp_logout,
            $crate::features::ipc::mcp::mcp_set_enabled,
            $crate::features::ipc::mcp::mcp_list_tools,
            $crate::features::ipc::sessions::agent_catalog,
            $crate::features::ipc::sessions::set_session_tuning,
            $crate::features::ipc::sessions::set_session_service_tier,
            $crate::features::ipc::sessions::set_collaboration_mode,
            $crate::features::ipc::sessions::set_thread_goal,
            $crate::features::ipc::sessions::clear_thread_goal,
            $crate::features::ipc::sessions::set_thread_goal_status,
            $crate::features::ipc::sessions::publish_thread_goal,
            $crate::features::ipc::sessions::review_targets,
            $crate::features::ipc::sessions::start_review,
            $crate::features::ipc::sessions::send_message,
            $crate::features::ipc::sessions::submit_annotation,
            $crate::features::ipc::sessions::diff_scopes,
            $crate::features::ipc::sessions::diff_for_scope,
            $crate::features::ipc::sessions::update_queued_turn,
            $crate::features::ipc::sessions::remove_queued_turn,
            $crate::features::ipc::sessions::steer_queued_turn,
            $crate::features::ipc::sessions::set_follow_up_queue_mode,
            $crate::features::ipc::sessions::session_queue,
            $crate::features::ipc::sessions::interrupt_turn,
            $crate::features::ipc::sessions::answer_prompt,
            $crate::features::ipc::sessions::stop_session,
            $crate::features::ipc::sessions::get_session_events,
            $crate::features::ipc::sessions::load_older_history,
            $crate::features::images::prepare_chat_image,
            $crate::features::images::stage_chat_image,
            $crate::features::preview::read_preview_file,
            $crate::features::preview::read_preview_image,
            $crate::features::preview::tree::list_project_dir,
            $crate::features::preview::tree::filter_project_paths,
            $crate::features::preview::search::search_project_files,
            $crate::features::preview::search::quick_open_files,
            $crate::features::preview::search::warm_project_index,
            $crate::features::preview::open_project_file,
            $crate::features::preview::file_open_capabilities,
            $crate::features::preview::browser::browser_close,
            $($extra),*
        ]
    };
}
#[cfg(feature = "dev-bridge")]
pub(crate) use workbench_handler;

/// 会话管理器经由 Tauri 事件推送。
pub(crate) fn app_emitter<R: Runtime>(app: AppHandle<R>) -> EventEmitter {
    Arc::new(move |channel, payload| {
        let _ = app.emit(channel, payload);
    })
}

pub(crate) fn manage_state<R: Runtime>(
    app: &AppHandle<R>,
    data_dir: &std::path::Path,
) -> Result<(), String> {
    let store = ProjectStore::load(data_dir).map_err(|e| format!("加载项目列表失败: {e}"))?;
    app.manage(store);
    let folders =
        TaskFolderStore::load(data_dir).map_err(|e| format!("加载任务文件夹失败: {e}"))?;
    app.manage(folders);
    app.manage(SessionManager::new(app_emitter(app.clone()), data_dir));
    app.manage(features::preview::search::IndexHub::default());
    app.manage(features::preview::tree::FilterHub::default());
    Ok(())
}

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
            manage_state(app.handle(), &data_dir)?;
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
        .invoke_handler(workbench_handler![
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
