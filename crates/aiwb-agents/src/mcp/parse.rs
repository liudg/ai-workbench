//! 各 CLI `mcp list` 的原文解析。形状来自 liudong-win 上的隔离探测，不是桌面文案。

use aiwb_core::models::McpServerRow;

pub fn parse_codex_list(text: &str) -> Result<Vec<McpServerRow>, String> {
    let value: serde_json::Value =
        serde_json::from_str(text.trim()).map_err(|err| format!("Codex MCP 列表不是 JSON：{err}"))?;
    let list = value
        .as_array()
        .ok_or_else(|| "Codex MCP 列表不是数组".to_string())?;
    let mut rows = Vec::new();
    for item in list {
        let name = item
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let transport = item.get("transport").cloned().unwrap_or(serde_json::Value::Null);
        let kind = transport
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let command = transport
            .get("command")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let args = transport
            .get("args")
            .and_then(|value| value.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let url = transport
            .get("url")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let bearer = transport
            .get("bearer_token_env_var")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let enabled = codex_enabled(item);
        let auth_status = item
            .get("auth_status")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        rows.push(McpServerRow {
            name,
            transport: kind,
            command,
            args,
            url,
            bearer_token_env_var: bearer,
            enabled,
            auth_status,
            status_text: item
                .get("disabled_reason")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim()
                .to_string(),
            scope: String::new(),
            cwd: transport
                .get("cwd")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            env: pairs(transport.get("env")),
            env_vars: strings(transport.get("env_vars")),
            headers: pairs(transport.get("http_headers")),
            env_headers: pairs(transport.get("env_http_headers")),
        });
    }
    Ok(rows)
}

/// Claude `mcp list` 文本。实测行形如：
/// `名字: cmd a b - ✔ Connected`、`名字: https://x/sse (SSE) - ✘ Failed to connect — 原因`。
/// claude.ai 连接器的名字带空格，插件的名字带冒号，所以按第一个 `: ` 切名字。
/// Cursor `mcp list` 文本是 `名字: 状态`，中间没有 ` - `。
/// 这里不填 `enabled`：Claude 没有开关，Cursor 由 [`parse_cursor_list`] 从状态原文填写。
pub fn parse_cli_list(text: &str) -> Vec<McpServerRow> {
    let mut rows = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("Checking MCP") || line.starts_with("No MCP servers") {
            continue;
        }
        let Some((name, rest)) = line.split_once(": ") else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let (command, status_text) = split_status(rest.trim());
        let (transport, url) = transport_of(&command);
        rows.push(McpServerRow {
            name: name.to_string(),
            transport,
            command: if url.is_empty() { command } else { String::new() },
            args: Vec::new(),
            url,
            bearer_token_env_var: String::new(),
            enabled: None,
            auth_status: String::new(),
            status_text,
            scope: String::new(),
            cwd: String::new(),
            env: Vec::new(),
            env_vars: Vec::new(),
            headers: Vec::new(),
            env_headers: Vec::new(),
        });
    }
    rows
}

const STATUS_MARKS: &[char] = &['✔', '✘', '✓', '✗', '√', '×', '⚠', '⏸', '!'];

/// 状态以符号开头。原因里也可能有 ` - `，所以找第一个后面紧跟状态符号的 ` - `。
fn split_status(rest: &str) -> (String, String) {
    let marked = rest.match_indices(" - ").find(|(at, sep)| {
        rest[at + sep.len()..]
            .chars()
            .next()
            .is_some_and(|ch| STATUS_MARKS.contains(&ch))
    });
    match marked.map(|(at, _)| at).or_else(|| rest.rfind(" - ")) {
        Some(at) => (rest[..at].trim().to_string(), rest[at + 3..].trim().to_string()),
        None => (String::new(), rest.to_string()),
    }
}

/// Cursor `mcp list` 的状态原文就是启用状态。`disabled` 为关，其余非空状态为开。
pub fn parse_cursor_list(text: &str) -> Vec<McpServerRow> {
    let mut rows = parse_cli_list(text);
    for row in &mut rows {
        row.enabled = enabled_from_cursor_status(&row.status_text);
    }
    rows
}

pub fn enabled_from_cursor_status(status: &str) -> Option<bool> {
    let bare = status
        .trim()
        .trim_start_matches(|ch: char| STATUS_MARKS.contains(&ch))
        .trim();
    if bare.is_empty() {
        return None;
    }
    let lower = bare.to_ascii_lowercase();
    if lower == "disabled" || lower.starts_with("disabled ") || lower.starts_with("disabled:") {
        Some(false)
    } else {
        Some(true)
    }
}

/// Codex 配置缺省是启用。`list --json` 有布尔 `enabled` 时用它；缺字段时按启用。
fn codex_enabled(item: &serde_json::Value) -> Option<bool> {
    match item.get("enabled") {
        Some(value) => value.as_bool().or_else(|| match value.as_str()?.trim() {
            "true" | "enabled" => Some(true),
            "false" | "disabled" => Some(false),
            _ => None,
        }),
        None => Some(true),
    }
}

fn pairs(value: Option<&serde_json::Value>) -> Vec<aiwb_core::models::McpPair> {
    let Some(object) = value.and_then(|item| item.as_object()) else {
        return Vec::new();
    };
    object
        .iter()
        .filter_map(|(key, item)| {
            let text = item.as_str().map(str::to_string).or_else(|| {
                if item.is_null() {
                    None
                } else {
                    Some(item.to_string())
                }
            })?;
            Some(aiwb_core::models::McpPair {
                key: key.clone(),
                value: text,
            })
        })
        .collect()
}

fn strings(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|item| item.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Claude 在 URL 后面标 `(SSE)` 或 `(HTTP)`；没标的网址按 HTTP。
fn transport_of(command: &str) -> (String, String) {
    let trimmed = command.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        let kind = if trimmed.is_empty() { "" } else { "stdio" };
        return (kind.into(), String::new());
    }
    for (suffix, kind) in [(" (SSE)", "sse"), (" (HTTP)", "http")] {
        if let Some(url) = trimmed.strip_suffix(suffix) {
            return (kind.into(), url.trim().to_string());
        }
    }
    ("http".into(), trimmed.to_string())
}

/// 已有服务器的名字照列表原文传。claude.ai 连接器的名字带空格，不能拒。
pub fn require_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('-') || name.chars().any(char::is_control) {
        return Err("服务器名称无效。".into());
    }
    Ok(name.to_string())
}

/// 新服务器的名字。不含空白，避免和 CLI 的输出格式混在一起。
pub fn require_new_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || name.starts_with('-')
        || name.chars().any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err("名称不能为空，不能含空白，也不能以 - 开头。".into());
    }
    Ok(name.to_string())
}

pub fn env_arg(key: &str, value: &str) -> Result<String, String> {
    let key = key.trim();
    if key.is_empty() || key.contains('=') || key.chars().any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err(format!("环境变量名无效：{key}"));
    }
    if value.chars().any(|ch| ch == '\n' || ch == '\r') {
        return Err("环境变量值不能换行。".into());
    }
    Ok(format!("{key}={value}"))
}

pub fn header_arg(key: &str, value: &str) -> Result<String, String> {
    let key = key.trim();
    if key.is_empty() || key.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
        return Err(format!("请求头名无效：{key}"));
    }
    if value.chars().any(|ch| ch == '\n' || ch == '\r') {
        return Err("请求头的值不能换行。".into());
    }
    Ok(format!("{key}: {value}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_stdio_and_http_json() {
        let text = r#"[
          {
            "name": "wb-mcp-probe",
            "enabled": true,
            "transport": {
              "type": "stdio",
              "command": "cmd",
              "args": ["/c", "echo", "wb-mcp-probe"],
              "env": null
            },
            "auth_status": "unsupported"
          },
          {
            "name": "wb-mcp-http",
            "enabled": true,
            "transport": {
              "type": "streamable_http",
              "url": "https://example.invalid/mcp",
              "bearer_token_env_var": "MCP_BEARER_TOKEN"
            },
            "auth_status": "bearer_token"
          }
        ]"#;
        let rows = parse_codex_list(text).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].transport, "stdio");
        assert_eq!(rows[0].args, vec!["/c", "echo", "wb-mcp-probe"]);
        assert_eq!(rows[0].auth_status, "unsupported");
        assert_eq!(rows[0].enabled, Some(true));
        assert_eq!(rows[1].transport, "streamable_http");
        assert_eq!(rows[1].bearer_token_env_var, "MCP_BEARER_TOKEN");
        assert_eq!(rows[1].auth_status, "bearer_token");
        assert_eq!(rows[1].enabled, Some(true));
    }

    #[test]
    fn codex_enabled_follows_config_and_defaults_on_when_omitted() {
        let text = r#"[
          { "name": "off", "enabled": false, "transport": { "type": "stdio", "command": "cmd" } },
          { "name": "word", "enabled": "disabled", "transport": { "type": "stdio", "command": "cmd" } },
          { "name": "plain", "transport": { "type": "stdio", "command": "cmd" } }
        ]"#;
        let rows = parse_codex_list(text).unwrap();
        assert_eq!(rows[0].enabled, Some(false));
        assert_eq!(rows[1].enabled, Some(false));
        assert_eq!(rows[2].enabled, Some(true));
    }

    #[test]
    fn parses_claude_and_cursor_list_lines() {
        // claude 2.1.312 实测输出。
        let claude = "Checking MCP server health…

claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected
demo: cmd /c echo demo - ✘ Failed to connect — MCP server \"demo\" connection timed out after 30000ms
wb-sse: https://example.invalid/sse (SSE) - ✘ Failed to connect — SSE error: ECONNRESET
wb-http: https://example.invalid/mcp (HTTP) - ✘ Failed to connect — a - b
plugin:tools:srv: C:/bin/srv.exe --flag - ⚠ Needs authentication
";
        let rows = parse_cli_list(claude);
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[0].name, "claude.ai Claude Docs");
        assert_eq!(rows[0].transport, "http");
        assert_eq!(rows[0].url, "https://api.anthropic.com/v1/pages/mcp");
        assert!(rows[0].command.is_empty());
        assert_eq!(rows[0].status_text, "✔ Connected");
        assert_eq!(rows[1].name, "demo");
        assert_eq!(rows[1].transport, "stdio");
        assert_eq!(rows[1].command, "cmd /c echo demo");
        assert!(rows[1].status_text.starts_with("✘ Failed to connect — MCP server"));
        assert_eq!(rows[1].enabled, None);
        assert_eq!(rows[2].transport, "sse");
        assert_eq!(rows[2].url, "https://example.invalid/sse");
        assert_eq!(rows[3].transport, "http");
        assert_eq!(rows[3].url, "https://example.invalid/mcp");
        assert_eq!(rows[3].status_text, "✘ Failed to connect — a - b");
        assert_eq!(rows[4].name, "plugin:tools:srv");
        assert_eq!(rows[4].command, "C:/bin/srv.exe --flag");
        assert_eq!(rows[4].status_text, "⚠ Needs authentication");

        assert!(parse_cli_list("No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)
").is_empty());

        let cursor = "rdp-ops: ready\nunityMCP: disabled\nquiet: disabled: paused\n";
        let rows = parse_cursor_list(cursor);
        assert_eq!(rows[0].name, "rdp-ops");
        assert_eq!(rows[0].status_text, "ready");
        assert_eq!(rows[0].enabled, Some(true));
        assert!(rows[0].command.is_empty());
        assert!(rows[0].transport.is_empty());
        assert_eq!(rows[1].enabled, Some(false));
        assert_eq!(rows[2].enabled, Some(false));
        assert_eq!(enabled_from_cursor_status(""), None);
        assert_eq!(enabled_from_cursor_status("needsAuth"), Some(true));
        assert_eq!(enabled_from_cursor_status("✔ disabled"), Some(false));
    }

    #[test]
    fn existing_names_keep_spaces_but_new_names_do_not() {
        assert_eq!(require_name(" claude.ai Claude Docs ").unwrap(), "claude.ai Claude Docs");
        assert!(require_name("--help").is_err());
        assert!(require_name("a
b").is_err());
        assert!(require_new_name("a b").is_err());
        assert!(require_new_name("-x").is_err());
        assert_eq!(require_new_name("wb-mcp").unwrap(), "wb-mcp");
    }

    #[test]
    fn codex_disabled_reason_becomes_status_text() {
        let text = r#"[{ "name": "off", "enabled": false, "disabled_reason": "startup failed", "transport": { "type": "stdio", "command": "cmd" } }]"#;
        let rows = parse_codex_list(text).unwrap();
        assert_eq!(rows[0].status_text, "startup failed");
    }
}
