//! 这一会话的权限菜单。「询问批准」把 Cursor 的审批请求交给用户；
//! 「跳过权限检查」由宿主替用户选「允许一次」，等同 `agent --force`，切换后下一个请求就生效。
//! 没有网络开关和额外目录：`agent acp` 没有对应参数，`--add-dir` 只在启动时生效。

use aiwb_core::models::{PermissionMenu, PermissionProfileOption};

pub fn permission_menu(active: &str) -> PermissionMenu {
    PermissionMenu {
        network_access: false,
        writable_roots: false,
        permission_profiles: false,
        approve_for_me: false,
        title: "权限".into(),
        notice: None,
        presets: vec![
            PermissionProfileOption {
                id: "full".into(),
                label: "跳过权限检查".into(),
                description: String::new(),
                disabled_reason: None,
                caution: true,
                allows_extras: false,
            },
            PermissionProfileOption {
                id: "ask".into(),
                label: "询问批准".into(),
                description: String::new(),
                disabled_reason: None,
                caution: false,
                allows_extras: false,
            },
        ],
        profiles: Vec::new(),
        active: Some(active.to_string()),
    }
}
