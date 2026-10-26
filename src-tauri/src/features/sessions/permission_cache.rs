//! 每个 Agent 最近一次成功打开的权限菜单。草稿不启动 CLI，只读这一份。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aiwb_core::models::{AgentKind, PermissionMenu};

pub struct PermissionMenuCache {
    file: PathBuf,
    menus: Mutex<HashMap<AgentKind, PermissionMenu>>,
}

impl PermissionMenuCache {
    pub fn load(data_dir: &Path) -> Self {
        let _ = fs::create_dir_all(data_dir);
        let file = data_dir.join("permission-menus.json");
        let menus = fs::read_to_string(&file)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self {
            file,
            menus: Mutex::new(menus),
        }
    }

    pub fn get(&self, kind: AgentKind) -> Option<PermissionMenu> {
        self.menus.lock().unwrap().get(&kind).cloned()
    }

    /// 空菜单不是一次成功的读取，不能盖住上一次有档位的结果。
    pub fn remember(&self, kind: AgentKind, menu: &PermissionMenu) {
        if menu.presets.is_empty() && menu.profiles.is_empty() {
            return;
        }
        let mut stored = menu.clone();
        stored.active = None;
        let mut menus = self.menus.lock().unwrap();
        menus.insert(kind, stored);
        if let Ok(raw) = serde_json::to_string_pretty(&*menus) {
            let _ = fs::write(&self.file, raw);
        }
    }
}
