//! 系统代理和 NO_PROXY。Codex 拉模型目录的超时很短，没有环境代理时补上当前用户的系统代理。

use tokio::process::Command;

#[derive(Debug, PartialEq, Eq)]
pub(in crate::features::agents::codex) struct SystemProxy {
    pub http: String,
    pub https: String,
    pub bypass: String,
}

pub(in crate::features::agents::codex) const LOOPBACK_NO_PROXY: &[&str] =
    &["localhost", "127.0.0.1", "::1"];

pub(in crate::features::agents::codex) fn merge_no_proxy(current: &str) -> String {
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

pub(in crate::features::agents::codex) fn explicit_proxy_configured() -> bool {
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
#[cfg(any(windows, test))]
pub(in crate::features::agents::codex) fn parse_windows_proxy_server(
    raw: &str,
) -> Option<(String, String)> {
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

#[cfg(any(windows, test))]
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
pub(in crate::features::agents::codex) fn sanitize_proxy_bypass(raw: &str) -> Vec<String> {
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
pub(in crate::features::agents::codex) fn read_windows_system_proxy() -> Option<SystemProxy> {
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
pub(in crate::features::agents::codex) fn read_windows_system_proxy() -> Option<SystemProxy> {
    None
}

/// Codex 拉 `https://chatgpt.com/backend-api/codex/models` 的总时限是 5 秒。
/// 直连在需要系统代理的网络上会把这 5 秒耗光，日志就是
/// `failed to refresh available models: request timed out`。
/// 环境里没有代理时，把当前用户的系统代理写成 `HTTP(S)_PROXY`，让这次请求走代理。
pub(in crate::features::agents::codex) fn apply_codex_network_env(command: &mut Command) {
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
