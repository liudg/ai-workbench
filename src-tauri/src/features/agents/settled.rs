//! 没有 npm 源的 CLI 自更新。
//!
//! 这类命令没有可查询的新版本。声明了 `self_update` 只说明「可以执行更新」，
//! 不说明「现在有更新」。一次成功的检查如果确认当前版本已是最新，就按
//! Agent 种类记下这个版本。版本字符串变了再重新提供更新。

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use crate::models::AgentKind;

/// 同版本已经确认过「已是最新」时，不再把更新按钮当成永远可用。
pub(crate) fn offer_self_update(
    can_update: bool,
    version: Option<&str>,
    settled: Option<&str>,
) -> bool {
    if !can_update {
        return false;
    }
    !matches!((version, settled), (Some(version), Some(settled)) if version == settled)
}

/// 已确认的版本填进 `latest_version`，供安装记录对照。
/// 更新按钮是否出现由 `update_available` 决定。
pub(crate) fn settled_latest(version: Option<&str>, settled: Option<&str>) -> Option<String> {
    match (version, settled) {
        (Some(version), Some(settled)) if version == settled => Some(version.to_string()),
        _ => None,
    }
}

struct SettledStore {
    path: PathBuf,
    versions: Mutex<HashMap<String, String>>,
}

impl SettledStore {
    fn open(path: PathBuf) -> Self {
        let versions = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self {
            path,
            versions: Mutex::new(versions),
        }
    }

    fn version(&self, kind: AgentKind) -> Option<String> {
        self.versions
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(kind.as_str())
            .cloned()
    }

    fn remember(&self, kind: AgentKind, version: &str) {
        if version.is_empty() {
            return;
        }
        let mut versions = self.versions.lock().unwrap_or_else(|err| err.into_inner());
        if versions.get(kind.as_str()).map(String::as_str) == Some(version) {
            return;
        }
        versions.insert(kind.as_str().to_string(), version.to_string());
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(raw) = serde_json::to_string_pretty(&*versions) {
            let _ = fs::write(&self.path, raw);
        }
    }
}

fn shared() -> &'static SettledStore {
    static STORE: OnceLock<SettledStore> = OnceLock::new();
    STORE.get_or_init(|| SettledStore::open(default_path()))
}

pub(crate) fn current_version(kind: AgentKind) -> Option<String> {
    shared().version(kind)
}

pub(crate) fn remember_current(kind: AgentKind, version: &str) {
    shared().remember(kind, version);
}

fn default_path() -> PathBuf {
    data_dir().join("agent-update-settled.json")
}

/// 与 Codex worktree 偏好用同一套应用数据目录。
fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("AI_WORKBENCH_DATA_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        return PathBuf::from(appdata).join("com.aiworkbench.app");
    }
    PathBuf::from(".").join("com.aiworkbench.app")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn self_update_stays_hidden_for_the_settled_version() {
        let version = "2026.10.01-e373342";
        assert!(!offer_self_update(true, Some(version), Some(version)));
        assert_eq!(
            settled_latest(Some(version), Some(version)).as_deref(),
            Some(version)
        );

        assert!(offer_self_update(
            true,
            Some("2026.10.08-ffff"),
            Some(version)
        ));
        assert_eq!(settled_latest(Some("2026.10.08-ffff"), Some(version)), None);
        assert!(offer_self_update(true, Some(version), None));
        assert!(!offer_self_update(false, Some("0.30.0"), None));
        assert_eq!(settled_latest(Some("0.30.0"), None), None);
    }

    #[test]
    fn settled_version_survives_reload_until_it_changes() {
        let dir = std::env::temp_dir().join(format!(
            "ai-workbench-settled-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let path = dir.join("agent-update-settled.json");
        let store = SettledStore::open(path.clone());
        assert_eq!(store.version(AgentKind::CursorAgent), None);

        store.remember(AgentKind::CursorAgent, "2026.10.01-e373342");
        store.remember(AgentKind::Goose, "1.0.0");
        assert_eq!(
            store.version(AgentKind::CursorAgent).as_deref(),
            Some("2026.10.01-e373342")
        );

        let reloaded = SettledStore::open(path);
        assert_eq!(
            reloaded.version(AgentKind::CursorAgent).as_deref(),
            Some("2026.10.01-e373342")
        );
        assert_eq!(reloaded.version(AgentKind::Goose).as_deref(), Some("1.0.0"));
        assert!(!offer_self_update(
            true,
            Some("2026.10.01-e373342"),
            reloaded.version(AgentKind::CursorAgent).as_deref(),
        ));

        reloaded.remember(AgentKind::CursorAgent, "2026.10.12-abc");
        assert_eq!(
            reloaded.version(AgentKind::CursorAgent).as_deref(),
            Some("2026.10.12-abc")
        );
        assert!(offer_self_update(
            true,
            Some("2026.10.01-e373342"),
            reloaded.version(AgentKind::CursorAgent).as_deref(),
        ));
        assert_file_has_kind(&reloaded.path, "cursor-agent", "2026.10.12-abc");

        reloaded.remember(AgentKind::CursorAgent, "");
        assert_eq!(
            reloaded.version(AgentKind::CursorAgent).as_deref(),
            Some("2026.10.12-abc")
        );
        let _ = fs::remove_dir_all(dir);
    }

    fn assert_file_has_kind(path: &Path, kind: &str, version: &str) {
        let raw = fs::read_to_string(path).expect("settled file");
        let map: HashMap<String, String> = serde_json::from_str(&raw).expect("json");
        assert_eq!(map.get(kind).map(String::as_str), Some(version));
    }
}
