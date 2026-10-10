//! 启动 Codex 进程：定位二进制、隐藏控制台、回环地址不走代理、stderr 分类。

use std::path::{Path, PathBuf};

use tokio::process::Command;

use crate::agents::AgentError;
use crate::encoding::{apply_utf8_env, decode_child_bytes};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum StderrClass {
    Ignore,
    Error(String),
    McpUnavailable { key: String, text: String },
}

pub(super) const LOOPBACK_NO_PROXY: &[&str] = &["localhost", "127.0.0.1", "::1"];

pub(super) fn merge_no_proxy(current: &str) -> String {
    let mut parts = Vec::new();
    for item in current.split(',') {
        let item = item.trim();
        if item.is_empty()
            || parts
                .iter()
                .any(|existing: &String| existing.eq_ignore_ascii_case(item))
        {
            continue;
        }
        parts.push(item.to_string());
    }
    for host in LOOPBACK_NO_PROXY {
        if !parts.iter().any(|existing| existing.eq_ignore_ascii_case(host)) {
            parts.push((*host).to_string());
        }
    }
    parts.join(",")
}

pub(super) fn apply_loopback_no_proxy(command: &mut Command) {
    let current = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .unwrap_or_default();
    let value = merge_no_proxy(&current);
    command.env("NO_PROXY", &value);
    command.env("no_proxy", &value);
}

pub(super) fn strip_ansi(text: &str) -> String {
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
pub(super) fn is_thread_writer_conflict(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("active writer") || lower.contains("thread-store conflict")
}

pub(super) fn classify_codex_stderr(raw: &str) -> StderrClass {
    let cleaned = strip_ansi(raw);
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed.contains("unrecognized configuration") {
        return StderrClass::Ignore;
    }
    // 占用冲突由 thread/resume 的结果转成只读通知，不要再当成会话失败打到时间线。
    if is_thread_writer_conflict(trimmed) {
        return StderrClass::Ignore;
    }
    if let Some(note) = mcp_transport_notice(trimmed) {
        return note;
    }
    if trimmed.contains("ERROR") {
        return StderrClass::Error(truncate(trimmed, 300));
    }
    StderrClass::Ignore
}

/// Codex 的可选 MCP 握手失败会以 `rmcp::transport::worker` ERROR 重试打到 stderr。
/// 核心对话走 app-server 的 stdio，不依赖这些服务。
pub(super) fn mcp_transport_notice(line: &str) -> Option<StderrClass> {
    let lower = line.to_ascii_lowercase();
    let mentions_mcp = lower.contains("rmcp::") || lower.contains("mcp");
    let transport_failure = lower.contains("transport channel closed")
        || lower.contains("unexpectedserverresponse")
        || lower.contains("unexpected server response")
        || lower.contains("error sending request")
        || lower.contains("connection refused")
        || lower.contains("os error 10061")
        || lower.contains("http 502")
        || lower.contains("http 503")
        || lower.contains("http 504");
    if !mentions_mcp
        || !transport_failure
        || !(lower.contains("error") || lower.contains("fatal"))
    {
        return None;
    }
    let target = mcp_failure_target(line);
    let text = match &target {
        Some(url) => format!("可选 MCP 未连接（{url}），已忽略，不影响对话。"),
        None if lower.contains("502") => "可选 MCP 连接失败（HTTP 502），已忽略，不影响对话。".into(),
        None if lower.contains("503") => "可选 MCP 连接失败（HTTP 503），已忽略，不影响对话。".into(),
        None if lower.contains("504") => "可选 MCP 连接失败（HTTP 504），已忽略，不影响对话。".into(),
        None => "可选 MCP 连接失败，已忽略，不影响对话。".into(),
    };
    let key = target.unwrap_or_else(|| {
        if lower.contains("502") {
            "http-502".into()
        } else if lower.contains("503") {
            "http-503".into()
        } else if lower.contains("504") {
            "http-504".into()
        } else {
            "mcp-transport".into()
        }
    });
    Some(StderrClass::McpUnavailable { key, text })
}

pub(super) fn mcp_failure_target(line: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    let start = lower.find("https://").or_else(|| lower.find("http://"))?;
    let rest = &line[start..];
    let end = rest
        .find(|ch: char| ch.is_whitespace() || matches!(ch, ')' | '"' | '\''))
        .unwrap_or(rest.len());
    let url = rest[..end]
        .trim_end_matches(|ch: char| matches!(ch, '.' | ',' | ';' | ')' | ']' | '}' | '"'))
        .to_string();
    if url.len() < 8 {
        None
    } else {
        Some(url)
    }
}

pub(super) fn trim_newline(raw: &mut Vec<u8>) {
    if raw.last() == Some(&b'\n') {
        raw.pop();
    }
    if raw.last() == Some(&b'\r') {
        raw.pop();
    }
}

pub(super) fn truncate(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(max).collect();
        out.push('…');
        out
    }
}

pub(super) fn resolve_codex_bin() -> Result<PathBuf, AgentError> {
    if let Some(path) = std::env::var_os("CODEX_BIN").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
    }
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_var) {
        let exe = dir.join("codex.exe");
        if exe.is_file() {
            return Ok(exe);
        }
    }
    for dir in std::env::split_paths(&path_var) {
        for name in ["codex.cmd", "codex.ps1", "codex"] {
            let shim = dir.join(name);
            if shim.is_file() {
                if let Some(found) = vendor_exe_near(&shim) {
                    return Ok(found);
                }
            }
        }
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let candidate = PathBuf::from(appdata).join(
            "npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
        );
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(AgentError::Runtime(
        "未找到 Codex CLI。请先安装并确保 `codex` 在 PATH 中（例如 npm i -g @openai/codex）。".into(),
    ))
}

pub(super) fn vendor_exe_near(shim: &Path) -> Option<PathBuf> {
    let parent = shim.parent()?;
    let rel = Path::new("node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
    let candidates = [parent.join(rel), parent.join("..").join(rel)];
    candidates.into_iter().find(|path| path.is_file())
}

pub(super) fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：GUI 宿主拉起控制台程序时不要弹出黑窗口。
        command.creation_flags(0x08000000);
    }
    let _ = command;
}

pub(super) async fn codex_version(bin: &Path) -> String {
    let mut command = Command::new(bin);
    command.arg("--version");
    apply_utf8_env(&mut command);
    hide_console(&mut command);
    apply_utf8_env(&mut command);
    let Ok(output) = command.output().await else {
        return "未知版本".into();
    };
    let text = decode_child_bytes(&output.stdout);
    text.lines()
        .next()
        .unwrap_or("codex")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_optional_mcp_transport_noise() {
        let ansi = "\u{1b}[2m2026-10-10T06:37:02.131976Z\u{1b}[0m \u{1b}[31mERROR\u{1b}[0m \u{1b}[2mrmcp::transport::worker\u{1b}[0m\u{1b}[2m:\u{1b}[0m worker quit with fatal: Transport channel closed, when UnexpectedServerResponse(\"HTTP 502: \")";
        match classify_codex_stderr(ansi) {
            StderrClass::McpUnavailable { key, text } => {
                assert_eq!(key, "http-502");
                assert_eq!(text, "可选 MCP 连接失败（HTTP 502），已忽略，不影响对话。");
                assert!(!text.contains('\u{1b}'));
            }
            other => panic!("expected mcp notice, got {other:?}"),
        }

        let direct = "2026-10-10T06:45:44.207643Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Client(HttpRequest(HttpRequest(\"http/request failed: error sending request for url (http://127.0.0.1:8080/mcp)\")))";
        match classify_codex_stderr(direct) {
            StderrClass::McpUnavailable { key, text } => {
                assert_eq!(key, "http://127.0.0.1:8080/mcp");
                assert!(text.contains("http://127.0.0.1:8080/mcp"));
                assert!(text.contains("不影响对话"));
            }
            other => panic!("expected url notice, got {other:?}"),
        }
    }

    #[test]
    fn hides_thread_store_writer_conflict() {
        let persistence = "2026-10-10T09:25:25.276357Z ERROR codex_core::session::session failed to initialize thread persistence: thread-store conflict: thread 01a124c7-226b-7bb0-a774-c5fccdab7471 already has an active writer";
        let create = "2026-10-10T09:25:25.278837Z ERROR codex_core::session Failed to create session: thread-store conflict: thread 01a124c7-226b-7bb0-a774-c5fccdab7471 already has an active writer";
        assert_eq!(classify_codex_stderr(persistence), StderrClass::Ignore);
        assert_eq!(classify_codex_stderr(create), StderrClass::Ignore);
        assert!(is_thread_writer_conflict(
            "thread abc already has an active writer"
        ));
        assert!(!is_thread_writer_conflict("authentication failed"));
    }

    #[test]
    fn keeps_real_codex_stderr_errors() {
        let line = "\u{1b}[31m2026-10-10T06:45:41Z ERROR codex_core: authentication failed\u{1b}[0m";
        match classify_codex_stderr(line) {
            StderrClass::Error(message) => {
                assert!(message.contains("authentication failed"));
                assert!(!message.contains('\u{1b}'));
            }
            other => panic!("expected error, got {other:?}"),
        }
        let config = "ERROR codex_app_server: Codex is ignoring 1 unrecognized configuration setting.";
        assert_eq!(classify_codex_stderr(config), StderrClass::Ignore);
    }

    #[test]
    fn no_proxy_includes_loopback() {
        assert_eq!(
            merge_no_proxy(""),
            "localhost,127.0.0.1,::1"
        );
        assert_eq!(
            merge_no_proxy("example.com, localhost"),
            "example.com,localhost,127.0.0.1,::1"
        );
    }
}
