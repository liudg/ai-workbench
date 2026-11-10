//! 这一会话的权限菜单。
//!
//! - 「跳过权限检查」由宿主替用户选「允许」，切换后下一个请求就生效。
//! - 「自动批准编辑」是原生的 `accept-edits` 模式，占工作台 approve-for-me 这一档：命令仍然要批准。
//! - 「询问批准」是原生的 `default` 模式。
//!
//! 额外目录是 `session/new` / `session/resume` 的 `additionalDirectories`，发下一条消息前换。
//! 没有网络开关，`--sandbox` 只在启动时生效。

use aiwb_core::models::{PermissionMenu, PermissionProfileOption};

pub fn permission_menu(active: &str) -> PermissionMenu {
    PermissionMenu {
        network_access: false,
        writable_roots: true,
        permission_profiles: false,
        approve_for_me: false,
        title: "权限".into(),
        notice: None,
        presets: vec![
            preset("full", "跳过权限检查", true),
            preset("approve-for-me", "自动批准编辑", false),
            preset("ask", "询问批准", false),
        ],
        profiles: Vec::new(),
        active: Some(active.to_string()),
    }
}

fn preset(id: &str, label: &str, caution: bool) -> PermissionProfileOption {
    PermissionProfileOption {
        id: id.into(),
        label: label.into(),
        description: String::new(),
        disabled_reason: None,
        caution,
        allows_extras: true,
    }
}
