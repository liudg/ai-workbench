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
            status_text: String::new(),
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

/// Claude `mcp list` 文本。探测到的行是 `名字: 命令 - 状态`。
/// Cursor `mcp list` 文本是 `名字: 状态`，中间没有 ` - `。
/// 这里不填 `enabled`：Claude 没有开关，Cursor 由 [`parse_cursor_list`] 从状态原文填写。
pub fn parse_cli_list(text: &str) -> Vec<McpServerRow> {
    let mut rows = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("Checking MCP") {
            continue;
        }
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let rest = rest.trim();
        let (command, status_text) = match rest.rsplit_once(" - ") {
            Some((command, status)) => (command.trim().to_string(), status.trim().to_string()),
            None => (String::new(), rest.to_string()),
        };
        let (transport, url) = transport_of(&command);
        rows.push(McpServerRow {
            name: name.to_string(),
            transport,
            command,
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
        .trim_start_matches(|ch: char| matches!(ch, '√' | '×' | '✓' | '✗'))
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

fn transport_of(command: &str) -> (String, String) {
    let trimmed = command.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return ("streamable_http".into(), trimmed.to_string());
    }
    if trimmed.is_empty() {
        (String::new(), String::new())
    } else {
        ("stdio".into(), String::new())
    }
}

pub fn require_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
        return Err("名称不能为空，也不能含空白。".into());
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
        let claude = "Checking MCP server health…\n\ndemo: cmd /c echo demo - × Failed to connect\nweb: https://example.invalid/mcp - √ Connected\n";
        let rows = parse_cli_list(claude);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "demo");
        assert_eq!(rows[0].transport, "stdio");
        assert_eq!(rows[0].command, "cmd /c echo demo");
        assert_eq!(rows[0].status_text, "× Failed to connect");
        assert_eq!(rows[1].transport, "streamable_http");
        assert_eq!(rows[1].url, "https://example.invalid/mcp");
        assert_eq!(rows[0].enabled, None);

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
    }
}
