//! `agy` 自己的数据目录：`<gemini 目录>/antigravity-cli/`（`ANTIGRAVITY_GEMINI_DIR` 或 `~/.gemini`）。
//! - `conversations/<id>.db` 是会话本身，`brain/<id>/` 是它的产物和转录，`annotations/<id>.pbtxt` 是批注。
//! - 子 Agent 的转录在 `brain/<子会话 id>/.system_generated/logs/transcript.jsonl`，
//!   登记在 `brain/<主会话 id>/.system_generated/subagents/<子会话 id>.json`。

use std::path::PathBuf;

/// `brain/<uuid>/` 下的路径算 Agent 自己的产物，不是项目文件。
pub fn is_artifact(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized
        .split_once("/brain/")
        .and_then(|(_, rest)| rest.split('/').next())
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}

pub fn data_dir() -> Option<PathBuf> {
    let env = |key: &str| {
        std::env::var_os(key)
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
    };
    let gemini = env("ANTIGRAVITY_GEMINI_DIR").or_else(|| Some(env("USERPROFILE").or_else(|| env("HOME"))?.join(".gemini")))?;
    Some(gemini.join("antigravity-cli"))
}

pub fn brain_dir(id: &str) -> Option<PathBuf> {
    data_dir().map(|dir| dir.join("brain").join(id))
}

/// 会话本身和它的产物都不在了。数据目录本身找不到时不下结论。
pub fn is_gone(id: &str) -> bool {
    data_dir().is_some_and(|root| gone_under(&root, id))
}

fn gone_under(root: &std::path::Path, id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
        && root.join("conversations").is_dir()
        && !root.join("conversations").join(format!("{id}.db")).exists()
        && !root.join("brain").join(id).exists()
}

/// ACP 没有删除方法。2026-11-09 实测：删掉这几处之后 `session/resume` 报读不到，`session/list` 里也没有了。
pub fn remove(id: &str) -> Result<(), String> {
    if uuid::Uuid::parse_str(id).is_err() || id.contains(['/', '\\', '.']) {
        return Err(format!("无效的会话 id：{id}"));
    }
    let root = data_dir().ok_or_else(|| "找不到 Antigravity 数据目录".to_string())?;
    let database = root.join("conversations").join(format!("{id}.db"));
    let brain = root.join("brain").join(id);
    if !database.is_file() && !brain.is_dir() {
        return Err(format!("找不到会话 {id}"));
    }
    if database.is_file() {
        std::fs::remove_file(&database).map_err(|err| format!("删不掉会话 {id}：{err}"))?;
    }
    for suffix in ["db-wal", "db-shm"] {
        let _ = std::fs::remove_file(root.join("conversations").join(format!("{id}.{suffix}")));
    }
    let _ = std::fs::remove_file(root.join("annotations").join(format!("{id}.pbtxt")));
    // 子 Agent 各是一条会话，记在父会话的 `.system_generated/subagents/<子会话 id>.json`。父会话删了它们也跟着删。
    for child in subagent_ids(&brain) {
        if child != id {
            let _ = remove(&child);
        }
    }
    if brain.is_dir() {
        std::fs::remove_dir_all(&brain).map_err(|err| format!("删不掉会话 {id} 的产物：{err}"))?;
    }
    Ok(())
}

fn subagent_ids(brain: &std::path::Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(brain.join(".system_generated").join("subagents")) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.path().file_stem().and_then(|stem| stem.to_str()).map(str::to_string))
        .filter(|stem| uuid::Uuid::parse_str(stem).is_ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{gone_under, subagent_ids};

    #[test]
    fn subagent_conversations_are_read_from_the_parent_brain() {
        let brain = tempfile::tempdir().unwrap();
        let dir = brain.path().join(".system_generated").join("subagents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("1b5c2f53-9d0e-4b6a-8a43-2b1c3d4e5f60.json"), "{}").unwrap();
        std::fs::write(dir.join("notes.json"), "{}").unwrap();
        assert_eq!(subagent_ids(brain.path()), vec!["1b5c2f53-9d0e-4b6a-8a43-2b1c3d4e5f60".to_string()]);
        assert!(subagent_ids(&brain.path().join("missing")).is_empty());
    }

    #[test]
    fn gone_only_when_conversation_and_brain_are_both_missing() {
        let root = tempfile::tempdir().unwrap();
        let id = "0b5c2f53-9d0e-4b6a-8a43-2b1c3d4e5f60";
        assert!(!gone_under(root.path(), id), "数据目录不全时不下结论");
        std::fs::create_dir_all(root.path().join("conversations")).unwrap();
        assert!(gone_under(root.path(), id));
        std::fs::create_dir_all(root.path().join("brain").join(id)).unwrap();
        assert!(!gone_under(root.path(), id));
        std::fs::remove_dir_all(root.path().join("brain")).unwrap();
        std::fs::write(root.path().join("conversations").join(format!("{id}.db")), b"").unwrap();
        assert!(!gone_under(root.path(), id));
        assert!(!gone_under(root.path(), "not-a-uuid"));
    }
}
