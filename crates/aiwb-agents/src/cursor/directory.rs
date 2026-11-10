//! `agent acp` 自己的会话目录：`<配置目录>/acp-sessions/<会话 id>/`，里面是 `store.db` 和 `meta.json`
//! （`{schemaVersion, cwd, title?}`）。配置目录照 `cursor-config/dist/paths.js`：
//! `CURSOR_CONFIG_DIR`，否则 `$XDG_CONFIG_HOME/cursor`，否则 `~/.cursor`。
//! `session/list` 回包不带标题，所以导入列表直接读这里。

use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde_json::Value;

use crate::DirectoryEntry;
use aiwb_core::models::{cwd_key, SessionStatus};

pub fn config_dir() -> Option<PathBuf> {
    let env = |key: &str| {
        std::env::var_os(key)
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
    };
    if let Some(dir) = env("CURSOR_CONFIG_DIR") {
        return Some(dir);
    }
    if let Some(dir) = env("XDG_CONFIG_HOME") {
        return Some(dir.join("cursor"));
    }
    let home = env("USERPROFILE").or_else(|| env("HOME"))?;
    Some(home.join(".cursor"))
}

pub fn sessions_dir() -> Option<PathBuf> {
    config_dir().map(|dir| dir.join("acp-sessions"))
}

pub fn is_session_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok() && !id.contains(['/', '\\', '.'])
}

pub fn list() -> Vec<DirectoryEntry> {
    let Some(root) = sessions_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut listed: Vec<DirectoryEntry> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let id = entry.file_name().to_string_lossy().to_string();
            if !is_session_id(&id) {
                return None;
            }
            let dir = entry.path();
            let meta: Value =
                serde_json::from_str(&std::fs::read_to_string(dir.join("meta.json")).ok()?).ok()?;
            let cwd = meta.get("cwd").and_then(Value::as_str)?.to_string();
            let title = meta
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let created_at = millis(std::fs::metadata(&dir).ok().and_then(|m| m.created().ok()));
            let updated_at = millis(
                std::fs::metadata(dir.join("store.db"))
                    .ok()
                    .and_then(|m| m.modified().ok()),
            )
            .max(created_at);
            Some(DirectoryEntry {
                native_id: id,
                cwd_key: cwd_key(&cwd),
                cwd,
                title,
                created_at,
                updated_at,
                status: SessionStatus::Completed,
                ephemeral: false,
                archived: false,
            })
        })
        .collect();
    listed.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    listed
}

fn millis(time: Option<std::time::SystemTime>) -> i64 {
    time.and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// `session/new` 只写 `meta.json`，`store.db` 在第一条消息时才建；`session/load` 先查 `store.db`。
pub fn is_placeholder(id: &str) -> bool {
    if !is_session_id(id) {
        return false;
    }
    let Some(dir) = sessions_dir().map(|root| root.join(id)) else {
        return false;
    };
    dir.join("meta.json").is_file() && !dir.join("store.db").exists()
}

/// 会话目录整个不在了。`session/new` 就写了 `meta.json`，所以没发过消息的会话不算。会话根目录找不到时不下结论。
pub fn is_gone(id: &str) -> bool {
    sessions_dir().is_some_and(|root| gone_under(&root, id))
}

fn gone_under(root: &std::path::Path, id: &str) -> bool {
    is_session_id(id) && root.is_dir() && !root.join(id).exists()
}

/// 没有删除会话的 ACP 方法。删掉目录之后 `session/load` 报 `Session "<id>" not found`。
pub fn remove(id: &str) -> Result<(), String> {
    if !is_session_id(id) {
        return Err(format!("无效的会话 id：{id}"));
    }
    let dir = sessions_dir()
        .map(|root| root.join(id))
        .ok_or_else(|| "找不到 Cursor 配置目录".to_string())?;
    if !dir.is_dir() {
        return Err(format!("找不到会话 {id}"));
    }
    std::fs::remove_dir_all(&dir).map_err(|err| format!("删不掉会话 {id}：{err}"))
}

#[cfg(test)]
mod tests {
    use super::gone_under;

    #[test]
    fn gone_only_when_the_session_folder_is_missing() {
        let root = tempfile::tempdir().unwrap();
        let id = "0b5c2f53-9d0e-4b6a-8a43-2b1c3d4e5f60";
        assert!(gone_under(root.path(), id));
        std::fs::create_dir_all(root.path().join(id)).unwrap();
        assert!(!gone_under(root.path(), id), "只有 meta.json 的空会话不算没了");
        assert!(!gone_under(&root.path().join("missing"), "1b5c2f53-9d0e-4b6a-8a43-2b1c3d4e5f60"), "根目录不在时不下结论");
        assert!(!gone_under(root.path(), "not-a-uuid"));
    }
}
