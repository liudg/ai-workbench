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
    if brain.is_dir() {
        std::fs::remove_dir_all(&brain).map_err(|err| format!("删不掉会话 {id} 的产物：{err}"))?;
    }
    Ok(())
}
