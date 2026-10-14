//! 重命名写入 jsonl 尾部。
//!
//! 对齐 `session_mutations.py` `rename_session`（L53–109）：追加一行紧凑 JSON
//! `{"type":"custom-title","customTitle":...,"sessionId":...}`。
//! `list_sessions` 读的是文件尾部最后一条 `customTitle`，重复改名以最后一条为准。
//! 活会话上的 `rename_session` 控制请求由 runtime 另发，文件才是目录的依据。

use std::io::Write;
use std::path::Path;

use super::history::{self, find_session_file};

pub fn append_custom_title(session_id: &str, title: &str) -> Result<std::path::PathBuf, String> {
    if !history::is_uuid(session_id) {
        return Err(format!("无效的会话 id：{session_id}"));
    }
    let title = title.trim();
    if title.is_empty() {
        return Err("标题不能为空".into());
    }
    let path = find_session_file(session_id).ok_or_else(|| format!("找不到会话文件 {session_id}"))?;
    append_custom_title_at(&path, session_id, title)?;
    Ok(path)
}

pub fn append_custom_title_at(path: &Path, session_id: &str, title: &str) -> Result<(), String> {
    let line = serde_json::json!({
        "type": "custom-title",
        "customTitle": title,
        "sessionId": session_id,
    });
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|err| format!("无法写入会话标题：{err}"))?;
    let text = serde_json::to_string(&line).map_err(|err| err.to_string())?;
    file.write_all(text.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.flush())
        .map_err(|err| format!("无法写入会话标题：{err}"))
}
