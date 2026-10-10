//! 启动 Codex 进程：定位二进制、隐藏控制台、系统代理、stderr 分类。

use std::path::{Path, PathBuf};

use tokio::process::Command;

use crate::agents::AgentError;
use crate::encoding::{apply_utf8_env, decode_child_bytes};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum StderrClass {
    Ignore,
    Error(String),
    /// 可见，但不把会话标成失败。模型目录刷新失败时 Codex 会继续用缓存。
    Notice(String),
    McpUnavailable {
        key: String,
        text: String,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct SystemProxy {
    pub http: String,
    pub https: String,
    pub bypass: String,
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
        if !parts
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(host))
        {
            parts.push((*host).to_string());
        }
    }
    parts.join(",")
}

pub(super) fn explicit_proxy_configured() -> bool {
    [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ]
    .iter()
    .any(|key| {
        std::env::var(key)
            .ok()
            .is_some_and(|value| !value.trim().is_empty())
    })
}

/// `host:port` → `http://host:port`。按协议分开的 `http=…;https=…` 分别取值。
pub(super) fn parse_windows_proxy_server(raw: &str) -> Option<(String, String)> {
    let raw = raw.trim().trim_matches('"');
    if raw.is_empty() {
        return None;
    }
    if raw.contains('=') {
        let mut http = None;
        let mut https = None;
        for part in raw.split(|ch: char| ch == ';' || ch.is_whitespace()) {
            let Some((scheme, rest)) = part.trim().split_once('=') else {
                continue;
            };
            let Some(url) = normalize_proxy_endpoint(rest) else {
                continue;
            };
            match scheme.trim().to_ascii_lowercase().as_str() {
                "http" => http = Some(url),
                "https" => https = Some(url),
                _ => {}
            }
        }
        let https = https.or_else(|| http.clone())?;
        let http = http.unwrap_or_else(|| https.clone());
        return Some((http, https));
    }
    let url = normalize_proxy_endpoint(raw)?;
    Some((url.clone(), url))
}

fn normalize_proxy_endpoint(raw: &str) -> Option<String> {
    let raw = raw.trim().trim_matches('"');
    if raw.is_empty() || raw.contains('*') {
        return None;
    }
    if raw.contains("://") {
        return Some(raw.to_string());
    }
    if raw.contains(':') {
        return Some(format!("http://{raw}"));
    }
    None
}

/// Windows `ProxyOverride` 用分号和 `*.domain`。reqwest / hyper-util 只认逗号列表，
/// 且把单独的 `*` 当成「全部直连」。带星号的条目除了 `*.domain` 一律丢掉。
pub(super) fn sanitize_proxy_bypass(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    for item in raw.split(|ch: char| matches!(ch, ';' | ',' | ' ' | '\n' | '\r' | '\t')) {
        let item = item.trim();
        if item.is_empty() || item.eq_ignore_ascii_case("<local>") {
            continue;
        }
        if let Some(domain) = item.strip_prefix("*.") {
            if !domain.is_empty() && !domain.contains('*') && !domain.contains(':') {
                push_unique(&mut out, &format!(".{domain}"));
            }
            continue;
        }
        if item.contains('*') {
            continue;
        }
        push_unique(&mut out, item);
    }
    out
}

fn push_unique(out: &mut Vec<String>, item: &str) {
    if !out
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(item))
    {
        out.push(item.to_string());
    }
}

#[cfg(windows)]
pub(super) fn read_windows_system_proxy() -> Option<SystemProxy> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    let enabled: u32 = key.get_value("ProxyEnable").unwrap_or(0);
    if enabled == 0 {
        return None;
    }
    let server: String = key.get_value("ProxyServer").ok()?;
    let (http, https) = parse_windows_proxy_server(&server)?;
    let bypass: String = key.get_value("ProxyOverride").unwrap_or_default();
    Some(SystemProxy {
        http,
        https,
        bypass,
    })
}

#[cfg(not(windows))]
pub(super) fn read_windows_system_proxy() -> Option<SystemProxy> {
    None
}

/// Codex 拉 `https://chatgpt.com/backend-api/codex/models` 的总时限是 5 秒。
/// 直连在需要系统代理的网络上会把这 5 秒耗光，日志就是
/// `failed to refresh available models: request timed out`。
/// 环境里没有代理时，把当前用户的系统代理写成 `HTTP(S)_PROXY`，让这次请求走代理。
pub(super) fn apply_codex_network_env(command: &mut Command) {
    let bypass = if explicit_proxy_configured() {
        None
    } else if let Some(proxy) = read_windows_system_proxy() {
        command.env("HTTP_PROXY", &proxy.http);
        command.env("http_proxy", &proxy.http);
        command.env("HTTPS_PROXY", &proxy.https);
        command.env("https_proxy", &proxy.https);
        Some(proxy.bypass)
    } else {
        None
    };
    let mut current = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .unwrap_or_default();
    if let Some(bypass) = bypass.as_deref() {
        let extra = sanitize_proxy_bypass(bypass).join(",");
        if !extra.is_empty() {
            if !current.is_empty() && !current.ends_with(',') {
                current.push(',');
            }
            current.push_str(&extra);
        }
    }
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
    // 模型目录刷新失败时 Codex 仍用缓存继续。超时不是会话失败。
    if let Some(note) = models_refresh_notice(trimmed) {
        return note;
    }
    if trimmed.contains("ERROR") {
        return StderrClass::Error(truncate(trimmed, 300));
    }
    StderrClass::Ignore
}

/// `codex_models_manager` 的刷新超时。其它刷新失败仍按错误显示。
pub(super) fn models_refresh_notice(line: &str) -> Option<StderrClass> {
    let lower = line.to_ascii_lowercase();
    let timed_out = lower.contains("timed out") || lower.contains("timeout waiting");
    if !lower.contains("codex_models_manager")
        || !lower.contains("failed to refresh available models")
        || !timed_out
    {
        return None;
    }
    Some(StderrClass::Notice(
        "模型列表刷新超时，已继续使用已有模型。".into(),
    ))
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
    if !mentions_mcp || !transport_failure || !(lower.contains("error") || lower.contains("fatal"))
    {
        return None;
    }
    let target = mcp_failure_target(line);
    let text = match &target {
        Some(url) => format!("可选 MCP 未连接（{url}），已忽略，不影响对话。"),
        None if lower.contains("502") => {
            "可选 MCP 连接失败（HTTP 502），已忽略，不影响对话。".into()
        }
        None if lower.contains("503") => {
            "可选 MCP 连接失败（HTTP 503），已忽略，不影响对话。".into()
        }
        None if lower.contains("504") => {
            "可选 MCP 连接失败（HTTP 504），已忽略，不影响对话。".into()
        }
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
        "未找到 Codex CLI。请先安装并确保 `codex` 在 PATH 中（例如 npm i -g @openai/codex）。"
            .into(),
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
    text.lines().next().unwrap_or("codex").trim().to_string()
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
        let line =
            "\u{1b}[31m2026-10-10T06:45:41Z ERROR codex_core: authentication failed\u{1b}[0m";
        match classify_codex_stderr(line) {
            StderrClass::Error(message) => {
                assert!(message.contains("authentication failed"));
                assert!(!message.contains('\u{1b}'));
            }
            other => panic!("expected error, got {other:?}"),
        }
        let config =
            "ERROR codex_app_server: Codex is ignoring 1 unrecognized configuration setting.";
        assert_eq!(classify_codex_stderr(config), StderrClass::Ignore);
    }

    #[test]
    fn no_proxy_includes_loopback() {
        assert_eq!(merge_no_proxy(""), "localhost,127.0.0.1,::1");
        assert_eq!(
            merge_no_proxy("example.com, localhost"),
            "example.com,localhost,127.0.0.1,::1"
        );
    }

    #[test]
    fn parses_windows_proxy_server() {
        assert_eq!(
            parse_windows_proxy_server("127.0.0.1:7897"),
            Some((
                "http://127.0.0.1:7897".into(),
                "http://127.0.0.1:7897".into()
            ))
        );
        assert_eq!(
            parse_windows_proxy_server(
                "http=10.0.0.1:8888;https=10.0.0.2:8889;socks=10.0.0.3:1080"
            ),
            Some(("http://10.0.0.1:8888".into(), "http://10.0.0.2:8889".into()))
        );
        assert_eq!(
            parse_windows_proxy_server("https://proxy.example:443"),
            Some((
                "https://proxy.example:443".into(),
                "https://proxy.example:443".into()
            ))
        );
        assert_eq!(parse_windows_proxy_server(""), None);
        assert_eq!(parse_windows_proxy_server("socks=127.0.0.1:1080"), None);
    }

    #[test]
    fn bypass_list_keeps_domains_and_drops_match_all() {
        let bypass = sanitize_proxy_bypass(
            "localhost;127.*;192.168.*;<local>;*.taole.com;*enterprise.aigcfast*;*",
        );
        assert_eq!(
            bypass,
            vec!["localhost".to_string(), ".taole.com".to_string()]
        );
        let merged = merge_no_proxy(&bypass.join(","));
        assert!(merged.split(',').any(|item| item == "127.0.0.1"));
        assert!(merged.split(',').any(|item| item == ".taole.com"));
        assert!(!merged.split(',').any(|item| item == "*"));
        assert!(!merged.split(',').any(|item| item.contains("127.*")));
    }

    #[test]
    fn models_refresh_timeout_stays_visible_without_failing_the_session() {
        let line = "2026-10-10T10:23:16.863473Z ERROR codex_models_manager::manager: failed to refresh available models: request timed out";
        assert_eq!(
            classify_codex_stderr(line),
            StderrClass::Notice("模型列表刷新超时，已继续使用已有模型。".into())
        );
        let other = "2026-10-10T10:23:16Z ERROR codex_models_manager::manager: failed to refresh available models: authentication failed";
        match classify_codex_stderr(other) {
            StderrClass::Error(message) => assert!(message.contains("authentication failed")),
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn live_system_proxy_is_an_http_url() {
        let Some(proxy) = read_windows_system_proxy() else {
            return;
        };
        assert!(
            proxy.https.starts_with("http://") || proxy.https.starts_with("https://"),
            "{}",
            proxy.https
        );
        assert!(!proxy.https.contains('*'));
        assert_eq!(proxy.http.contains("://"), true);
    }
}
