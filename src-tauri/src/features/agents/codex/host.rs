//! 不依赖某条对话线程的 Codex 宿主调用。
//!
//! MCP、插件、钩子和环境都走一份常驻的 `codex app-server`。
//! 配置写在 `CODEX_HOME/config.toml`，和桌面端、CLI、IDE 扩展共用。

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

use crate::features::agents::AgentError;
use crate::models::{
    EnvironmentRecord, HookRecord, MarketplaceRecord, McpLogin, McpServerRecord, McpTransport,
    PluginCatalog, PluginRecord,
};

use super::rpc_client::codex_call;

const PAGE_LIMIT: i64 = 100;

fn remembered_environments() -> &'static Mutex<Vec<String>> {
    static IDS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    IDS.get_or_init(|| Mutex::new(Vec::new()))
}

async fn call(method: &str, params: Value, budget: Duration) -> Result<Value, AgentError> {
    codex_call(method, params, budget).await
}

pub async fn list_mcp_servers() -> Result<Vec<McpServerRecord>, AgentError> {
    let config = call("config/read", json!({}), Duration::from_secs(20)).await?;
    let mut status_pages = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..20 {
        let mut params = json!({ "limit": PAGE_LIMIT, "detail": "toolsAndAuthOnly" });
        if let Some(cursor) = &cursor {
            params["cursor"] = json!(cursor);
        }
        let page = call("mcpServerStatus/list", params, Duration::from_secs(30)).await?;
        status_pages.push(page.clone());
        cursor = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|cursor| !cursor.is_empty())
            .map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    Ok(merge_mcp_servers(&config, &status_pages))
}

pub async fn add_mcp_server(
    name: &str,
    transport: McpTransport,
    command_line: &str,
    url: &str,
) -> Result<(), AgentError> {
    let name = validate_server_name(name)?;
    let value = match transport {
        McpTransport::Stdio => {
            let (command, args) = split_stdio_command(command_line)?;
            json!({ "command": command, "args": args, "enabled": true })
        }
        McpTransport::Http => {
            let url = url.trim();
            if url.is_empty() {
                return Err(AgentError::Runtime("Streamable HTTP 需要填写 URL".into()));
            }
            json!({ "url": url, "enabled": true })
        }
    };
    write_config(&format!("mcp_servers.{name}"), "upsert", value).await
}

pub async fn set_mcp_server_enabled(name: &str, enabled: bool) -> Result<(), AgentError> {
    let name = validate_server_name(name)?;
    write_config(
        &format!("mcp_servers.{name}"),
        "upsert",
        json!({ "enabled": enabled }),
    )
    .await
}

pub async fn remove_mcp_server(name: &str) -> Result<(), AgentError> {
    let name = validate_server_name(name)?;
    write_config(&format!("mcp_servers.{name}"), "replace", Value::Null).await
}

pub async fn login_mcp_server(name: &str) -> Result<McpLogin, AgentError> {
    let name = validate_server_name(name)?;
    let result = call(
        "mcpServer/oauth/login",
        json!({ "name": name, "timeoutSecs": 180 }),
        Duration::from_secs(30),
    )
    .await?;
    let authorization_url = result
        .get("authorizationUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if authorization_url.is_empty() {
        return Err(AgentError::Runtime("Codex 没有返回身份验证地址".into()));
    }
    open_authorization(&authorization_url);
    Ok(McpLogin { authorization_url })
}

pub async fn reload_mcp_config() -> Result<(), AgentError> {
    call("config/mcpServer/reload", Value::Null, Duration::from_secs(30))
        .await
        .map(|_| ())
}

pub async fn list_plugins(cwd: Option<&str>) -> Result<PluginCatalog, AgentError> {
    let cwd = cwd.map(str::to_string);
    let all_kinds = json!([
        "local",
        "vertical",
        "workspace-directory",
        "shared-with-me",
        "created-by-me-remote"
    ]);
    match plugin_list(cwd.as_deref(), &all_kinds, false).await {
        Ok(catalog) => Ok(catalog),
        Err(err) => {
            let message = err.to_string();
            if !message.to_ascii_lowercase().contains("auth") {
                return Err(err);
            }
            match plugin_list(cwd.as_deref(), &json!(["local", "workspace-directory"]), false).await {
                Ok(mut local) => {
                    local.errors.insert(0, message);
                    Ok(local)
                }
                Err(local_err) if local_err.to_string().to_ascii_lowercase().contains("auth") => {
                    Ok(PluginCatalog {
                        marketplaces: Vec::new(),
                        errors: vec![message],
                    })
                }
                Err(local_err) => Err(local_err),
            }
        }
    }
}

async fn plugin_list(
    cwd: Option<&str>,
    kinds: &Value,
    force_refetch: bool,
) -> Result<PluginCatalog, AgentError> {
    let mut params = json!({
        "marketplaceKinds": kinds,
        "forceRefetch": force_refetch,
    });
    if let Some(cwd) = cwd.filter(|cwd| !cwd.trim().is_empty()) {
        params["cwds"] = json!([cwd]);
    }
    let value = call("plugin/list", params, Duration::from_secs(45)).await?;
    Ok(parse_plugin_catalog(&value))
}

pub async fn install_plugin(
    plugin_name: &str,
    marketplace_path: &str,
    marketplace_name: &str,
) -> Result<(), AgentError> {
    let plugin_name = plugin_name.trim();
    if plugin_name.is_empty() {
        return Err(AgentError::Runtime("缺少插件名".into()));
    }
    let mut params = json!({ "pluginName": plugin_name });
    if !marketplace_path.trim().is_empty() {
        params["marketplacePath"] = json!(marketplace_path.trim());
    } else if !marketplace_name.trim().is_empty() {
        params["remoteMarketplaceName"] = json!(marketplace_name.trim());
    }
    call("plugin/install", params, Duration::from_secs(120))
        .await
        .map(|_| ())
}

pub async fn uninstall_plugin(plugin_id: &str) -> Result<(), AgentError> {
    let plugin_id = plugin_id.trim();
    if plugin_id.is_empty() {
        return Err(AgentError::Runtime("缺少插件 id".into()));
    }
    call(
        "plugin/uninstall",
        json!({ "pluginId": plugin_id }),
        Duration::from_secs(60),
    )
    .await
    .map(|_| ())
}

pub async fn add_marketplace(source: &str, ref_name: &str) -> Result<(), AgentError> {
    let source = source.trim();
    if source.is_empty() {
        return Err(AgentError::Runtime("填写本地目录或 Git 地址".into()));
    }
    let mut params = json!({ "source": source });
    if !ref_name.trim().is_empty() {
        params["refName"] = json!(ref_name.trim());
    }
    call("marketplace/add", params, Duration::from_secs(120))
        .await
        .map(|_| ())
}

pub async fn remove_marketplace(name: &str) -> Result<(), AgentError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AgentError::Runtime("缺少 marketplace 名称".into()));
    }
    call(
        "marketplace/remove",
        json!({ "marketplaceName": name }),
        Duration::from_secs(60),
    )
    .await
    .map(|_| ())
}

pub async fn upgrade_marketplace(name: &str) -> Result<(), AgentError> {
    let mut params = json!({});
    if !name.trim().is_empty() {
        params["marketplaceName"] = json!(name.trim());
    }
    call("marketplace/upgrade", params, Duration::from_secs(120))
        .await
        .map(|_| ())
}

pub async fn list_hooks(cwd: Option<&str>) -> Result<Vec<HookRecord>, AgentError> {
    let params = match cwd.map(str::trim).filter(|cwd| !cwd.is_empty()) {
        Some(cwd) => json!({ "cwds": [cwd] }),
        None => json!({ "cwds": [] }),
    };
    let value = call("hooks/list", params, Duration::from_secs(30)).await?;
    Ok(parse_hooks(&value))
}

pub async fn add_environment(
    environment_id: &str,
    exec_server_url: &str,
    auth_bearer_token: &str,
) -> Result<EnvironmentRecord, AgentError> {
    let environment_id = environment_id.trim();
    let exec_server_url = exec_server_url.trim();
    if environment_id.is_empty() || exec_server_url.is_empty() {
        return Err(AgentError::Runtime(
            "填写环境 ID 和 exec server URL".into(),
        ));
    }
    let mut params = json!({
        "environmentId": environment_id,
        "execServerUrl": exec_server_url,
    });
    if !auth_bearer_token.trim().is_empty() {
        params["authBearerToken"] = json!(auth_bearer_token.trim());
    }
    let id = environment_id.to_string();
    call("environment/add", params, Duration::from_secs(30)).await?;
    remembered_environments()
        .lock()
        .unwrap()
        .retain(|item| item != &id);
    remembered_environments().lock().unwrap().push(id.clone());
    read_environment(&id).await
}

pub async fn list_environments() -> Result<Vec<EnvironmentRecord>, AgentError> {
    let ids = remembered_environments().lock().unwrap().clone();
    let mut listed = Vec::new();
    for id in ids {
        listed.push(read_environment(&id).await?);
    }
    Ok(listed)
}

async fn read_environment(id: &str) -> Result<EnvironmentRecord, AgentError> {
    let status = call(
        "environment/status",
        json!({ "environmentId": id }),
        Duration::from_secs(20),
    )
    .await?;
    let mut record = parse_environment_status(id, &status);
    if record.status == "ready" {
        if let Ok(info) = call(
            "environment/info",
            json!({ "environmentId": id }),
            Duration::from_secs(20),
        )
        .await
        {
            record.cwd = info
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            record.shell = info
                .pointer("/shell/name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
        }
    }
    Ok(record)
}

async fn write_config(key_path: &str, merge_strategy: &str, value: Value) -> Result<(), AgentError> {
    call(
        "config/value/write",
        json!({
            "keyPath": key_path,
            "mergeStrategy": merge_strategy,
            "value": value,
        }),
        Duration::from_secs(20),
    )
    .await
    .map(|_| ())
}

pub(super) fn validate_server_name(name: &str) -> Result<String, AgentError> {
    let name = name.trim();
    if name.is_empty()
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(AgentError::Runtime(
            "服务器名称只能包含字母、数字、下划线和连字符".into(),
        ));
    }
    Ok(name.to_string())
}

pub(super) fn split_stdio_command(input: &str) -> Result<(String, Vec<String>), AgentError> {
    let parts = split_command_line(input);
    let Some(command) = parts.first() else {
        return Err(AgentError::Runtime("STDIO 需要填写启动命令".into()));
    };
    if command.is_empty() {
        return Err(AgentError::Runtime("STDIO 需要填写启动命令".into()));
    }
    Ok((command.clone(), parts.into_iter().skip(1).collect()))
}

pub(super) fn split_command_line(input: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match quote {
            Some(mark) if ch == mark => quote = None,
            Some(_) if ch == '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
            }
            None => current.push(ch),
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

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
    let url = value.get("url").and_then(Value::as_str).unwrap_or("").trim().to_string();
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
    let enabled = value.get("enabled").and_then(Value::as_bool).unwrap_or(true);
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
        return "没有配置 MCP 服务器。在设置 → MCP 服务器里选择「添加服务器」。".into();
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

pub(super) fn parse_plugin_catalog(value: &Value) -> PluginCatalog {
    let mut errors = Vec::new();
    if let Some(list) = value.get("marketplaceLoadErrors").and_then(Value::as_array) {
        for item in list {
            if let Some(message) = item.get("message").and_then(Value::as_str) {
                errors.push(message.to_string());
            }
        }
    }
    let mut marketplaces = Vec::new();
    let Some(list) = value.get("marketplaces").and_then(Value::as_array) else {
        return PluginCatalog { marketplaces, errors };
    };
    for item in list {
        let name = item.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let display_name = item
            .pointer("/interface/displayName")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .unwrap_or(&name)
            .to_string();
        let path = item.get("path").and_then(Value::as_str).unwrap_or("").to_string();
        let plugins = item
            .get("plugins")
            .and_then(Value::as_array)
            .map(|plugins| {
                plugins
                    .iter()
                    .filter_map(|plugin| parse_plugin(plugin, &name, &path))
                    .collect()
            })
            .unwrap_or_default();
        marketplaces.push(MarketplaceRecord {
            name,
            display_name,
            path,
            plugins,
        });
    }
    marketplaces.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    PluginCatalog { marketplaces, errors }
}

fn parse_plugin(value: &Value, marketplace_name: &str, marketplace_path: &str) -> Option<PluginRecord> {
    let name = value.get("name").and_then(Value::as_str).unwrap_or("").trim();
    if name.is_empty() {
        return None;
    }
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or(name)
        .to_string();
    let display_name = value
        .pointer("/interface/displayName")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or(name)
        .to_string();
    let description = value
        .pointer("/interface/shortDescription")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .or_else(|| {
            value
                .pointer("/interface/longDescription")
                .and_then(Value::as_str)
        })
        .unwrap_or("")
        .to_string();
    Some(PluginRecord {
        developer: value
            .pointer("/interface/developerName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        description,
        display_name,
        id,
        name: name.to_string(),
        marketplace_name: marketplace_name.to_string(),
        marketplace_path: marketplace_path.to_string(),
        installed: value.get("installed").and_then(Value::as_bool).unwrap_or(false),
        enabled: value.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        availability: value
            .get("availability")
            .and_then(Value::as_str)
            .unwrap_or("AVAILABLE")
            .to_string(),
        install_policy: value
            .get("installPolicy")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        source: value
            .pointer("/source/type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        needs_install_confirm: value
            .get("mustShowInstallationInterstitial")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
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
                source: hook.get("source").and_then(Value::as_str).unwrap_or("").to_string(),
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
        return "这个目录没有发现钩子。设置 → 钩子可以按当前项目再查一次。".into();
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

pub(super) fn parse_environment_status(id: &str, value: &Value) -> EnvironmentRecord {
    EnvironmentRecord {
        id: id.to_string(),
        status: value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        error: value.get("error").and_then(Value::as_str).unwrap_or("").to_string(),
        cwd: String::new(),
        shell: String::new(),
    }
}

fn open_authorization(url: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .creation_flags(0x08000000)
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let context = servers.iter().find(|server| server.name == "context7").unwrap();
        assert_eq!(context.transport, McpTransport::Stdio);
        assert_eq!(context.args, vec!["-y".to_string(), "@upstash/context7-mcp".to_string()]);
    }

    #[test]
    fn splits_quoted_stdio_command() {
        let (command, args) = split_stdio_command(r#"npx -y "@upstash/context7-mcp""#).unwrap();
        assert_eq!(command, "npx");
        assert_eq!(args, vec!["-y".to_string(), "@upstash/context7-mcp".to_string()]);
    }

    #[test]
    fn rejects_unsafe_server_names() {
        assert!(validate_server_name("my server").is_err());
        assert!(validate_server_name("a.b").is_err());
        assert_eq!(validate_server_name("context7").unwrap(), "context7");
    }

    #[test]
    fn parses_plugins_and_hooks() {
        let catalog = parse_plugin_catalog(&json!({
            "marketplaces": [{
                "name": "openai-bundled",
                "interface": { "displayName": "OpenAI" },
                "path": "C:/market",
                "plugins": [{
                    "id": "browser@openai-bundled",
                    "name": "browser",
                    "installed": true,
                    "enabled": true,
                    "availability": "AVAILABLE",
                    "installPolicy": "AVAILABLE",
                    "source": { "type": "local" },
                    "interface": { "displayName": "Browser", "shortDescription": "Browse", "developerName": "OpenAI" }
                }]
            }],
            "marketplaceLoadErrors": [{ "message": "skipped" }]
        }));
        assert_eq!(catalog.marketplaces[0].display_name, "OpenAI");
        assert_eq!(catalog.marketplaces[0].plugins[0].display_name, "Browser");
        assert_eq!(catalog.errors, vec!["skipped".to_string()]);

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

    /// 只在 `_gap-mcp-plugins` 的隔离 CODEX_HOME 里跑。不设置这两个环境变量时直接失败，避免写到用户的 `~/.codex`。
    #[tokio::test]
    #[ignore = "isolated CODEX_HOME under _gap-mcp-plugins; does not touch the user Codex config"]
    async fn live_gap_mcp_plugins_hooks_env_worktree() {
        let gap = require_gap_home();
        let user_config = read_user_codex_config();
        let home = gap.join("codex-home");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("gap home");
        std::fs::write(home.join("config.toml"), "model = \"gpt-5.4\"\n").expect("config");

        add_mcp_server("gap_live", McpTransport::Stdio, "cmd /c exit 0", "")
            .await
            .expect("add mcp");
        let listed = list_mcp_servers().await.expect("list mcp");
        let server = listed.iter().find(|item| item.name == "gap_live").expect("gap_live listed");
        assert_eq!(server.transport, McpTransport::Stdio);
        assert!(server.enabled);
        set_mcp_server_enabled("gap_live", false).await.expect("disable");
        let disabled = list_mcp_servers().await.expect("list disabled");
        assert!(!disabled.iter().find(|item| item.name == "gap_live").unwrap().enabled);
        reload_mcp_config().await.expect("reload");
        remove_mcp_server("gap_live").await.expect("remove");
        let gone = list_mcp_servers().await.expect("list after remove");
        assert!(gone.iter().all(|item| item.name != "gap_live"));

        let hooks = list_hooks(Some(gap.to_str().unwrap())).await.expect("hooks");
        assert!(hooks.is_empty() || hooks.iter().all(|hook| hook.cwd.replace('\\', "/").contains("_gap-mcp-plugins")));

        let env = read_environment("missing-gap").await.expect("env status");
        assert_eq!(env.status, "unknown");

        let market = gap.join("market");
        write_gap_marketplace(&market);
        add_marketplace(market.to_str().unwrap(), "").await.expect("add marketplace");
        let catalog = list_plugins(Some(gap.to_str().unwrap())).await.expect("plugins");
        let saw_market = catalog.marketplaces.iter().any(|item| item.name == "gap-market");
        let auth_limited = catalog
            .errors
            .iter()
            .any(|item| item.to_ascii_lowercase().contains("auth"));
        assert!(
            saw_market || auth_limited,
            "expected the local marketplace or the desktop auth notice: {catalog:?}"
        );
        remove_marketplace("gap-market").await.expect("remove marketplace");

        let repo = gap.join("repo");
        init_gap_repo(&repo);
        let root = gap.join("worktrees");
        super::super::worktree::save_settings(root.to_str().unwrap(), 15, false).expect("prefs");
        let created = super::super::worktree::create_worktree(repo.to_str().unwrap())
            .await
            .expect("worktree");
        assert!(created.detached);
        assert!(created.path.replace('\\', "/").contains("_gap-mcp-plugins/worktrees"));
        super::super::worktree::recycle_worktree(repo.to_str().unwrap(), &created.path)
            .await
            .expect("recycle");

        assert_eq!(read_user_codex_config(), user_config);
    }

    fn require_gap_home() -> std::path::PathBuf {
        let home = std::env::var("CODEX_HOME").unwrap_or_default();
        let data = std::env::var("AI_WORKBENCH_DATA_DIR").unwrap_or_default();
        assert!(
            home.replace('\\', "/").contains("_gap-mcp-plugins/codex-home"),
            "refusing live test: set CODEX_HOME to _gap-mcp-plugins/codex-home"
        );
        assert!(
            data.replace('\\', "/").contains("_gap-mcp-plugins/"),
            "refusing live test: set AI_WORKBENCH_DATA_DIR inside _gap-mcp-plugins"
        );
        std::path::PathBuf::from(&home)
            .parent()
            .expect("gap parent")
            .to_path_buf()
    }

    fn read_user_codex_config() -> Option<Vec<u8>> {
        let home = std::env::var("USERPROFILE").ok()?;
        std::fs::read(std::path::PathBuf::from(home).join(".codex").join("config.toml")).ok()
    }

    fn write_gap_marketplace(root: &std::path::Path) {
        let plugin = root.join("plugins").join("gap-echo").join(".codex-plugin");
        std::fs::create_dir_all(root.join(".agents").join("plugins")).unwrap();
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(
            plugin.join("plugin.json"),
            r#"{"name":"gap-echo","version":"0.0.1","interface":{"displayName":"Gap Echo"}}"#,
        )
        .unwrap();
        std::fs::write(
            root.join(".agents").join("plugins").join("marketplace.json"),
            r#"{
              "name": "gap-market",
              "interface": { "displayName": "Gap Market" },
              "plugins": [{
                "name": "gap-echo",
                "source": { "source": "local", "path": "./plugins/gap-echo" },
                "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
                "category": "Developer Tools"
              }]
            }"#,
        )
        .unwrap();
    }

    fn init_gap_repo(repo: &std::path::Path) {
        let _ = std::fs::remove_dir_all(repo);
        std::fs::create_dir_all(repo).unwrap();
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(repo)
                .status()
                .expect("git");
            assert!(status.success(), "git {args:?}");
        };
        git(&["init"]);
        std::fs::write(repo.join("README.md"), "gap\n").unwrap();
        git(&["add", "README.md"]);
        let status = std::process::Command::new("git")
            .args(["-c", "user.email=gap@example.com", "-c", "user.name=gap", "commit", "-m", "gap"])
            .current_dir(repo)
            .status()
            .expect("commit");
        assert!(status.success(), "commit");
    }
}
