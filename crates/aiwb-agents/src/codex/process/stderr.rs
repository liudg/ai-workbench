//! stderr 分类和日志。协议错误走 stdout 的 JSON-RPC，stderr 整行都是 tracing。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, PartialEq, Eq)]
pub(in crate::codex) enum StderrClass {
    Ignore,
    /// app-server 自己的 tracing。只写日志，不进时间线。
    Log(String),
}

pub(in crate::codex) fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

/// 另一个 Codex / 工作台已经拿着这条线程的写锁。`thread/resume` 会失败，但历史仍可读。
pub(in crate::codex) fn is_thread_writer_conflict(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("active writer") || lower.contains("thread-store conflict")
}

pub(in crate::codex) fn classify_codex_stderr(raw: &str) -> StderrClass {
    let cleaned = strip_ansi(raw);
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return StderrClass::Ignore;
    }
    // 协议错误和回合失败走 stdout 的 JSON-RPC。stderr 整行都是 tracing。
    StderrClass::Log(truncate(trimmed, 4000))
}

const STDERR_LOG_LIMIT: u64 = 4 * 1024 * 1024;

fn stderr_log_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub(in crate::codex) fn remember_agent_stderr(line: &str) {
    let Some(path) = stderr_log_path() else {
        return;
    };
    let _guard = stderr_log_lock()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    rotate_stderr_log(&path);
    let mut file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(_) => return,
    };
    use std::io::Write;
    let _ = writeln!(file, "{line}");
}

fn stderr_log_path() -> Option<PathBuf> {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))?;
    Some(
        root.join("ai-workbench")
            .join("logs")
            .join("agent-stderr.log"),
    )
}

fn rotate_stderr_log(path: &Path) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() < STDERR_LOG_LIMIT {
        return;
    }
    let backup = path.with_extension("1.log");
    let _ = std::fs::remove_file(&backup);
    let _ = std::fs::rename(path, backup);
}

pub(in crate::codex) fn trim_newline(raw: &mut Vec<u8>) {
    if raw.last() == Some(&b'\n') {
        raw.pop();
    }
    if raw.last() == Some(&b'\r') {
        raw.pop();
    }
}

pub(in crate::codex) fn truncate(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(max).collect();
        out.push('…');
        out
    }
}
