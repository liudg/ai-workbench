//! 启动 Codex 进程：定位二进制、隐藏控制台、系统代理、stderr 分类。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tokio::process::Command;

use crate::encoding::{apply_utf8_env, decode_child_bytes};
use crate::features::agents::AgentError;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum StderrClass {
    Ignore,
    /// app-server 自己的 tracing。只写日志，不进时间线。
    Log(String),
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
        if !item.is_empty() {
            push_unique(&mut parts, item);
        }
    }
    for host in LOOPBACK_NO_PROXY {
        push_unique(&mut parts, host);
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
    for item in raw.split([';', ',', ' ', '\n', '\r', '\t']) {
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

pub(super) fn remember_agent_stderr(line: &str) {
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
            if let Some(found) = vendor_exe_near(&path) {
                return Ok(found);
            }
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
    #[cfg(not(windows))]
    let mut launcher = None;
    for dir in std::env::split_paths(&path_var) {
        for name in ["codex.cmd", "codex.ps1", "codex"] {
            let shim = dir.join(name);
            if !shim.is_file() {
                continue;
            }
            if let Some(found) = vendor_exe_near(&shim) {
                return Ok(found);
            }
            #[cfg(not(windows))]
            if launcher.is_none() && name == "codex" {
                launcher = Some(shim);
            }
        }
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let candidate = PathBuf::from(appdata)
            .join("npm/node_modules/@openai/codex")
            .join(platform_vendor_suffix().unwrap_or(""));
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    // 原生包缺失时，Unix 上的 npm 启动脚本会自己报错，不在这里假装找到了二进制。
    #[cfg(not(windows))]
    if let Some(launcher) = launcher {
        return Ok(launcher);
    }
    Err(AgentError::Runtime(
        "未找到 Codex CLI。请先安装并确保 `codex` 在 PATH 中（例如 npm i -g @openai/codex）。"
            .into(),
    ))
}

/// 当前平台的 Codex 原生包，相对 `@openai/codex` 包目录。
/// 对照 `@openai/codex` 的 `bin/codex.js`（`PLATFORM_PACKAGE_BY_TARGET`）。
fn platform_vendor_suffix() -> Option<&'static str> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        Some("node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe")
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        Some("node_modules/@openai/codex-win32-arm64/vendor/aarch64-pc-windows-msvc/bin/codex.exe")
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        Some("node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex")
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        Some("node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex")
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        Some("node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex")
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        Some("node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex")
    }
    #[cfg(not(any(
        all(
            target_os = "windows",
            any(target_arch = "x86_64", target_arch = "aarch64")
        ),
        all(
            target_os = "linux",
            any(target_arch = "x86_64", target_arch = "aarch64")
        ),
        all(
            target_os = "macos",
            any(target_arch = "x86_64", target_arch = "aarch64")
        ),
    )))]
    {
        None
    }
}

pub(super) fn vendor_exe_near(shim: &Path) -> Option<PathBuf> {
    let suffix = platform_vendor_suffix()?;
    let mut roots = Vec::new();
    if let Some(parent) = shim.parent() {
        roots.push(parent.to_path_buf());
    }
    if let Ok(real) = std::fs::canonicalize(shim) {
        if let Some(parent) = real.parent() {
            if !roots.iter().any(|root| root == parent) {
                roots.push(parent.to_path_buf());
            }
        }
    }
    for start in roots {
        let mut dir = start;
        for _ in 0..8 {
            if let Some(found) = vendor_at(&dir, suffix) {
                return Some(found);
            }
            if !dir.pop() {
                break;
            }
        }
    }
    None
}

fn vendor_at(dir: &Path, suffix: &str) -> Option<PathBuf> {
    [
        dir.join("node_modules/@openai/codex").join(suffix),
        dir.join("lib/node_modules/@openai/codex").join(suffix),
        dir.join(suffix),
    ]
    .into_iter()
    .find(|path| path.is_file())
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
    fn ignores_optional_mcp_transport_noise() {
        let ansi = "\u{1b}[2m2026-10-10T06:37:02.131976Z\u{1b}[0m \u{1b}[31mERROR\u{1b}[0m \u{1b}[2mrmcp::transport::worker\u{1b}[0m\u{1b}[2m:\u{1b}[0m worker quit with fatal: Transport channel closed, when UnexpectedServerResponse(\"HTTP 502: \")";
        assert!(matches!(classify_codex_stderr(ansi), StderrClass::Log(_)));

        let direct = "2026-10-10T06:45:44.207643Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Client(HttpRequest(HttpRequest(\"http/request failed: error sending request for url (http://127.0.0.1:8080/mcp)\")))";
        assert!(matches!(classify_codex_stderr(direct), StderrClass::Log(_)));
    }

    #[test]
    fn hides_thread_store_writer_conflict() {
        let persistence = "2026-10-10T09:25:25.276357Z ERROR codex_core::session::session failed to initialize thread persistence: thread-store conflict: thread 01a124c7-226b-7bb0-a774-c5fccdab7471 already has an active writer";
        let create = "2026-10-10T09:25:25.278837Z ERROR codex_core::session Failed to create session: thread-store conflict: thread 01a124c7-226b-7bb0-a774-c5fccdab7471 already has an active writer";
        assert!(matches!(
            classify_codex_stderr(persistence),
            StderrClass::Log(_)
        ));
        assert!(matches!(classify_codex_stderr(create), StderrClass::Log(_)));
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
            StderrClass::Log(message) => {
                assert!(message.contains("authentication failed"));
                assert!(!message.contains('\u{1b}'));
            }
            other => panic!("expected log, got {other:?}"),
        }
        let memory = r"2026-10-11T05:34:12Z ERROR codex_core::tools::router: error=apply_patch verification failed: invalid patch: multiple operations target C:\Users\admin\.codex\memories\memory_summary.md";
        match classify_codex_stderr(memory) {
            StderrClass::Log(message) => assert!(message.contains("memory_summary.md")),
            other => panic!("expected log, got {other:?}"),
        }
        let config =
            "ERROR codex_app_server: Codex is ignoring 1 unrecognized configuration setting.";
        assert!(matches!(classify_codex_stderr(config), StderrClass::Log(_)));
        assert!(matches!(classify_codex_stderr("  "), StderrClass::Ignore));
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
    fn vendor_exe_near_finds_npm_prefix_and_package_bin() {
        let Some(suffix) = platform_vendor_suffix() else {
            return;
        };
        let root = std::env::temp_dir().join(format!(
            "ai-workbench-codex-vendor-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&root);
        let prefix_bin = root
            .join("prefix/lib/node_modules/@openai/codex")
            .join(suffix);
        std::fs::create_dir_all(prefix_bin.parent().unwrap()).unwrap();
        std::fs::write(&prefix_bin, b"codex").unwrap();
        let shim_dir = root.join("prefix/bin");
        std::fs::create_dir_all(&shim_dir).unwrap();
        let shim = shim_dir.join("codex");
        std::fs::write(&shim, b"shim").unwrap();
        assert_eq!(
            vendor_exe_near(&shim).as_deref(),
            Some(prefix_bin.as_path())
        );

        let package_bin = root.join("pkg/node_modules/@openai/codex").join(suffix);
        std::fs::create_dir_all(package_bin.parent().unwrap()).unwrap();
        std::fs::write(&package_bin, b"codex").unwrap();
        let script_dir = root.join("pkg/node_modules/@openai/codex/bin");
        std::fs::create_dir_all(&script_dir).unwrap();
        let script = script_dir.join("codex.js");
        std::fs::write(&script, b"script").unwrap();
        assert_eq!(
            vendor_exe_near(&script).as_deref(),
            Some(package_bin.as_path())
        );
        let _ = std::fs::remove_dir_all(&root);
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
        assert!(proxy.http.contains("://"));
    }
}
