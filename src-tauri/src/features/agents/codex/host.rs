//! 斜杠 `/mcp` 和 `/hooks` 用的解析与文案。
//! 会话线程自己发 `config/read`、`mcpServerStatus/list` 和 `hooks/list`。

use serde_json::Value;

use crate::models::{HookRecord, McpServerRecord, McpTransport};

pub(super) fn merge_mcp_servers(config: &Value, status_pages: &[Value]) -> Vec<McpServerRecord> {
    let configured = config
        .pointer("/config/mcp_servers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut by_name: std::collections::BTreeMap<String, McpServerRecord> = configured
        .into_iter()
        .map(|(name, value)| (name.clone(), server_from_config(&name, &value)))
        .collect();
    for page in status_pages {
        let Some(list) = page.get("data").and_then(Value::as_array) else {
            continue;
        };
        for item in list {
            let name = item.get("name").and_then(Value::as_str).unwrap_or("").trim();
            if name.is_empty() {
                continue;
            }
            let entry = by_name
                .entry(name.to_string())
                .or_insert_with(|| server_from_config(name, &Value::Null));
            apply_status(entry, item);
        }
    }
    by_name.into_values().collect()
}

fn server_from_config(name: &str, value: &Value) -> McpServerRecord {
    let url = value
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let command = value
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let args = value
        .get("args")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let enabled = value
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    McpServerRecord {
        name: name.to_string(),
        transport: if url.is_empty() {
            McpTransport::Stdio
        } else {
            McpTransport::Http
        },
        command,
        args,
        url,
        enabled,
        auth_status: String::new(),
        runtime_status: String::new(),
        tool_names: Vec::new(),
        tools_error: String::new(),
        plugin_id: String::new(),
    }
}

fn apply_status(entry: &mut McpServerRecord, item: &Value) {
    if let Some(auth) = item.get("authStatus").and_then(Value::as_str) {
        entry.auth_status = auth.to_string();
    }
    entry.runtime_status = item
        .get("runtimeStatus")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if entry.runtime_status == "disabled" {
        entry.enabled = false;
    }
    entry.tools_error = item
        .get("toolsError")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    entry.plugin_id = item
        .get("pluginId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if let Some(tools) = item.get("tools").and_then(Value::as_object) {
        let mut names: Vec<String> = tools.keys().cloned().collect();
        names.sort();
        entry.tool_names = names;
    }
}

pub(super) fn render_mcp(servers: &[McpServerRecord], verbose: bool) -> String {
    if servers.is_empty() {
        return "没有配置 MCP 服务器。".into();
    }
    let mut lines = vec!["MCP 服务器".to_string()];
    for server in servers {
        let state = runtime_label(&server.runtime_status);
        lines.push(format!(
            "{}  {state}  {} 个工具",
            server.name,
            server.tool_names.len()
        ));
        if verbose {
            let transport = match server.transport {
                McpTransport::Http => format!("Streamable HTTP {}", server.url),
                McpTransport::Stdio => {
                    let mut command = server.command.clone();
                    if !server.args.is_empty() {
                        command.push(' ');
                        command.push_str(&server.args.join(" "));
                    }
                    format!("STDIO {command}")
                }
            };
            lines.push(format!(
                "  {transport}  认证 {}  {}",
                auth_label(&server.auth_status),
                if server.enabled { "已启用" } else { "已禁用" }
            ));
            if !server.tools_error.is_empty() {
                lines.push(format!("  {}", server.tools_error));
            }
            for tool in &server.tool_names {
                lines.push(format!("  - {tool}"));
            }
        } else {
            for tool in server.tool_names.iter().take(8) {
                lines.push(format!("  - {tool}"));
            }
            if server.tool_names.len() > 8 {
                lines.push(format!("  … 另有 {} 个", server.tool_names.len() - 8));
            }
        }
    }
    if !verbose {
        lines.push("用法：/mcp verbose 查看传输、认证和全部工具。".into());
    }
    lines.join("\n")
}

pub(super) fn runtime_label(status: &str) -> &'static str {
    match status {
        "notStarted" => "未启动",
        "starting" => "正在启动",
        "connected" => "已连接",
        "authenticationRequired" => "需要登录",
        "failed" => "失败",
        "cancelled" => "已取消",
        "disabled" => "已禁用",
        _ => "未连接",
    }
}

pub(super) fn auth_label(status: &str) -> &'static str {
    match status {
        "unsupported" => "不需要登录",
        "notLoggedIn" => "未登录",
        "bearerToken" => "Bearer",
        "oAuth" => "OAuth",
        "unknown" => "未知",
        _ => "未知",
    }
}

pub(super) fn parse_hooks(value: &Value) -> Vec<HookRecord> {
    let mut hooks = Vec::new();
    let Some(rows) = value.get("data").and_then(Value::as_array) else {
        return hooks;
    };
    for row in rows {
        let cwd = row.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
        let Some(list) = row.get("hooks").and_then(Value::as_array) else {
            continue;
        };
        for hook in list {
            let event_name = hook
                .get("eventName")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if event_name.is_empty() {
                continue;
            }
            hooks.push(HookRecord {
                handler: hook_handler(hook),
                source: hook
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                trust_status: hook
                    .get("trustStatus")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                enabled: hook.get("enabled").and_then(Value::as_bool).unwrap_or(false),
                status_message: hook
                    .get("statusMessage")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                cwd: cwd.clone(),
                event_name,
            });
        }
    }
    hooks
}

fn hook_handler(hook: &Value) -> String {
    if let Some(command) = hook.get("command").and_then(Value::as_str) {
        return command.to_string();
    }
    let server = hook.get("server").and_then(Value::as_str).unwrap_or("");
    let tool = hook.get("tool").and_then(Value::as_str).unwrap_or("");
    if !server.is_empty() || !tool.is_empty() {
        return format!("{server}/{tool}");
    }
    hook.get("handlerType")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

pub(super) fn render_hooks(hooks: &[HookRecord]) -> String {
    if hooks.is_empty() {
        return "这个目录没有发现钩子。".into();
    }
    let mut lines = vec!["钩子".to_string()];
    for hook in hooks {
        let trust = match hook.trust_status.as_str() {
            "managed" => "托管",
            "trusted" => "已信任",
            "untrusted" => "未信任",
            "modified" => "已修改",
            other => other,
        };
        let enabled = if hook.enabled { "启用" } else { "未启用" };
        lines.push(format!(
            "{}  {}  {enabled}  {trust}  {}",
            hook.event_name, hook.handler, hook.source
        ));
        if hook.trust_status == "untrusted" {
            lines.push("  未信任的钩子在审查前不会运行。".into());
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merges_config_and_status() {
        let config = json!({
            "config": {
                "mcp_servers": {
                    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
                    "figma": { "url": "https://mcp.figma.com/mcp", "enabled": true }
                }
            }
        });
        let status = json!({
            "data": [{
                "name": "figma",
                "authStatus": "notLoggedIn",
                "runtimeStatus": "authenticationRequired",
                "tools": { "get_file": {} },
                "resourceTemplates": [],
                "resources": []
            }]
        });
        let servers = merge_mcp_servers(&config, &[status]);
        assert_eq!(servers.len(), 2);
        let figma = servers.iter().find(|server| server.name == "figma").unwrap();
        assert_eq!(figma.transport, McpTransport::Http);
        assert_eq!(figma.auth_status, "notLoggedIn");
        assert_eq!(figma.tool_names, vec!["get_file".to_string()]);
        let context = servers
            .iter()
            .find(|server| server.name == "context7")
            .unwrap();
        assert_eq!(context.transport, McpTransport::Stdio);
        assert_eq!(
            context.args,
            vec!["-y".to_string(), "@upstash/context7-mcp".to_string()]
        );
    }

    #[test]
    fn parses_hooks() {
        let hooks = parse_hooks(&json!({
            "data": [{
                "cwd": "C:/repo",
                "errors": [],
                "warnings": [],
                "hooks": [{
                    "eventName": "preToolUse",
                    "command": "echo hi",
                    "handlerType": "command",
                    "enabled": true,
                    "trustStatus": "untrusted",
                    "source": "project",
                    "statusMessage": null
                }]
            }]
        }));
        assert_eq!(hooks[0].handler, "echo hi");
        assert!(render_hooks(&hooks).contains("未信任"));
    }

    #[test]
    fn verbose_mcp_mentions_transport() {
        let text = render_mcp(
            &[McpServerRecord {
                name: "figma".into(),
                transport: McpTransport::Http,
                command: String::new(),
                args: Vec::new(),
                url: "https://mcp.figma.com/mcp".into(),
                enabled: true,
                auth_status: "oAuth".into(),
                runtime_status: "connected".into(),
                tool_names: vec!["get_file".into()],
                tools_error: String::new(),
                plugin_id: String::new(),
            }],
            true,
        );
        assert!(text.contains("Streamable HTTP"));
        assert!(text.contains("OAuth"));
    }
}
