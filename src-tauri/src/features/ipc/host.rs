//! Codex 宿主能力：MCP、插件、钩子、工作树、环境。
//! 命令只调用适配器契约，不解析 app-server 协议。

use tauri::State;

use crate::features::agents::{self, adapter_for};
use crate::features::sessions::SessionManager;
use crate::models::*;

fn codex() -> std::sync::Arc<dyn agents::AgentAdapter> {
    adapter_for(AgentKind::CodexCli)
}

#[tauri::command]
pub async fn list_mcp_servers() -> Result<Vec<McpServerRecord>, String> {
    codex().list_mcp_servers().await.map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn add_mcp_server(
    name: String,
    transport: McpTransport,
    command_line: String,
    url: String,
) -> Result<(), String> {
    codex()
        .add_mcp_server(&name, transport, &command_line, &url)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn set_mcp_server_enabled(name: String, enabled: bool) -> Result<(), String> {
    codex()
        .set_mcp_server_enabled(&name, enabled)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn remove_mcp_server(name: String) -> Result<(), String> {
    codex()
        .remove_mcp_server(&name)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn login_mcp_server(name: String) -> Result<McpLogin, String> {
    codex()
        .login_mcp_server(&name)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn reload_mcp_servers(manager: State<'_, SessionManager>) -> Result<ReloadReport, String> {
    codex()
        .reload_mcp_config()
        .await
        .map_err(|err| err.to_string())?;
    Ok(ReloadReport {
        warnings: manager.reload_live_mcp().await,
    })
}

#[tauri::command]
pub async fn list_plugins(cwd: Option<String>) -> Result<PluginCatalog, String> {
    codex()
        .list_plugins(cwd.as_deref())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn install_plugin(
    plugin_name: String,
    marketplace_path: String,
    marketplace_name: String,
) -> Result<(), String> {
    codex()
        .install_plugin(&plugin_name, &marketplace_path, &marketplace_name)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn uninstall_plugin(plugin_id: String) -> Result<(), String> {
    codex()
        .uninstall_plugin(&plugin_id)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn add_marketplace(source: String, ref_name: String) -> Result<(), String> {
    codex()
        .add_marketplace(&source, &ref_name)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn remove_marketplace(name: String) -> Result<(), String> {
    codex()
        .remove_marketplace(&name)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn upgrade_marketplace(name: String) -> Result<(), String> {
    codex()
        .upgrade_marketplace(&name)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn list_hooks(cwd: Option<String>) -> Result<Vec<HookRecord>, String> {
    codex()
        .list_hooks(cwd.as_deref())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn worktree_settings(project_path: Option<String>) -> Result<WorktreeSettings, String> {
    codex()
        .worktree_settings(project_path.as_deref())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn save_worktree_settings(
    root: String,
    keep: u32,
    auto_prune: bool,
) -> Result<WorktreeSettings, String> {
    codex()
        .save_worktree_settings(&root, keep, auto_prune)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn create_worktree(project_path: String) -> Result<WorktreeInfo, String> {
    codex()
        .create_worktree(&project_path)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn recycle_worktree(project_path: String, worktree_path: String) -> Result<(), String> {
    codex()
        .recycle_worktree(&project_path, &worktree_path)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn add_environment(
    environment_id: String,
    exec_server_url: String,
    auth_bearer_token: String,
) -> Result<EnvironmentRecord, String> {
    codex()
        .add_environment(&environment_id, &exec_server_url, &auth_bearer_token)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn list_environments() -> Result<Vec<EnvironmentRecord>, String> {
    codex()
        .list_environments()
        .await
        .map_err(|err| err.to_string())
}
