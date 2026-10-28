//! 系统托盘：常驻后台，关窗不退出。
//! 菜单：显示主窗口 / 退出。左键点击托盘图标同样唤起主窗口。退出时一起停掉后台服务；
//! 有会话还在跑就先确认。

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub const TRAY_ID: &str = "main-tray";
const MENU_SHOW: &str = "show";
const MENU_QUIT: &str = "quit";

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id(MENU_SHOW, "显示主窗口").build(app)?;
    let quit = MenuItemBuilder::with_id(MENU_QUIT, "退出").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("AI 工作台")
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => show_main_window(app),
            MENU_QUIT => confirm_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/// 有会话还在跑或在等输入时先问一句；退出会把它们一起停掉。
fn confirm_quit(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let running = app
            .path()
            .app_data_dir()
            .map(|dir| crate::daemon::running_sessions(&dir))
            .unwrap_or(0);
        if running == 0 {
            quit_app(&app);
            return;
        }
        let handle = app.clone();
        app.dialog()
            .message(format!("还有 {running} 个会话在运行。退出会停掉它们。"))
            .title("退出 AI 工作台")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("退出".into(), "取消".into()))
            .show(move |confirmed| {
                if confirmed {
                    quit_app(&handle);
                }
            });
    });
}

/// 退出应用时一起停掉后台服务。
fn quit_app(app: &AppHandle) {
    if let Ok(data_dir) = app.path().app_data_dir() {
        crate::daemon::shutdown(&data_dir);
    }
    app.exit(0);
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
