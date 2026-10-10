//! 系统托盘：常驻后台，关窗不退出。
//! 菜单：显示主窗口 / 退出。左键点击托盘图标同样唤起主窗口。

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const MENU_SHOW: &str = "show";
const MENU_QUIT: &str = "quit";

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id(MENU_SHOW, "显示主窗口").build(app)?;
    let quit = MenuItemBuilder::with_id(MENU_QUIT, "退出").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("AI 工作台")
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => show_main_window(app),
            MENU_QUIT => app.exit(0),
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

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
