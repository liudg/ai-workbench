//! MCP 管理命令。参数原样交给该 Agent 自己的 CLI。

use aiwb_agents as agents;
use aiwb_core::models::*;

#[tauri::command]
pub fn mcp_surfaces() -> Vec<McpSurface> {
    agents::mcp_surfaces()
}

#[tauri::command]
pub async fn mcp_list(kind: AgentKind) -> Result<Vec<McpServerRow>, String> {
    agents::require_mcp(kind)?.list().await
}

#[tauri::command]
pub async fn mcp_add(kind: AgentKind, spec: McpAddSpec) -> Result<String, String> {
    agents::require_mcp(kind)?.add(&spec).await
}

#[tauri::command]
pub async fn mcp_remove(kind: AgentKind, name: String, scope: String) -> Result<String, String> {
    agents::require_mcp(kind)?.remove(&name, &scope).await
}

#[tauri::command]
pub async fn mcp_login(
    kind: AgentKind,
    name: String,
    registration: String,
    scopes: String,
) -> Result<String, String> {
    agents::require_mcp(kind)?
        .login(&name, &registration, &scopes)
        .await
}

#[tauri::command]
pub async fn mcp_logout(kind: AgentKind, name: String) -> Result<String, String> {
    agents::require_mcp(kind)?.logout(&name).await
}

#[tauri::command]
pub async fn mcp_set_enabled(kind: AgentKind, name: String, enabled: bool) -> Result<String, String> {
    agents::require_mcp(kind)?.set_enabled(&name, enabled).await
}

#[tauri::command]
pub async fn mcp_list_tools(kind: AgentKind, name: String) -> Result<String, String> {
    agents::require_mcp(kind)?.list_tools(&name).await
}
