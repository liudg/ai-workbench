//! 这一会话的权限菜单。档位是 Claude 自己的 `permission_mode`，不是模型目录。

use crate::models::{PermissionMenu, PermissionProfileOption};

/// 只列出这一会话能选的档位。`active` 是当前 `permission_mode` 对应的档。
/// 网络开关保持关闭：`claude --print hi --network` 是 `unknown option '--network'`。
/// 额外目录是启动参数 `--add-dir`，所以两档都 `allows_extras`。
pub fn permission_menu(active: &str) -> PermissionMenu {
    PermissionMenu {
        network_access: false,
        writable_roots: true,
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
                allows_extras: true,
            },
            PermissionProfileOption {
                id: "ask".into(),
                label: "询问批准".into(),
                description: String::new(),
                disabled_reason: None,
                caution: false,
                allows_extras: true,
            },
        ],
        profiles: Vec::new(),
        active: Some(active.to_string()),
    }
}
