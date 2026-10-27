//! MCP 管理。参数原样交给该 Agent 自己的 CLI。照应用壳原来的 `features/ipc/mcp.rs`。

use aiwb_core::models::{AgentKind, McpAddSpec, McpServerRow, McpSurface};
use serde::Deserialize;

use super::{ServiceResult, Services};

#[derive(Deserialize)]
pub(crate) struct McpKind {
    kind: AgentKind,
}

#[derive(Deserialize)]
pub(crate) struct McpAdd {
    kind: AgentKind,
    spec: McpAddSpec,
}

#[derive(Deserialize)]
pub(crate) struct McpName {
    kind: AgentKind,
    name: String,
}

#[derive(Deserialize)]
pub(crate) struct McpRemove {
    kind: AgentKind,
    name: String,
    scope: String,
}

#[derive(Deserialize)]
pub(crate) struct McpLogin {
    kind: AgentKind,
    name: String,
    registration: String,
    scopes: String,
}

#[derive(Deserialize)]
pub(crate) struct McpEnabled {
    kind: AgentKind,
    name: String,
    enabled: bool,
}

impl Services {
    pub(crate) fn mcp_surfaces(&self) -> Vec<McpSurface> {
        aiwb_agents::mcp_surfaces()
    }

    pub(crate) async fn mcp_list(&self, params: McpKind) -> ServiceResult<Vec<McpServerRow>> {
        aiwb_agents::require_mcp(params.kind)?.list().await
    }

    pub(crate) async fn mcp_add(&self, params: McpAdd) -> ServiceResult<String> {
        aiwb_agents::require_mcp(params.kind)?.add(&params.spec).await
    }

    pub(crate) async fn mcp_remove(&self, params: McpRemove) -> ServiceResult<String> {
        aiwb_agents::require_mcp(params.kind)?.remove(&params.name, &params.scope).await
    }

    pub(crate) async fn mcp_login(&self, params: McpLogin) -> ServiceResult<String> {
        aiwb_agents::require_mcp(params.kind)?
            .login(&params.name, &params.registration, &params.scopes)
            .await
    }

    pub(crate) async fn mcp_logout(&self, params: McpName) -> ServiceResult<String> {
        aiwb_agents::require_mcp(params.kind)?.logout(&params.name).await
    }

    pub(crate) async fn mcp_set_enabled(&self, params: McpEnabled) -> ServiceResult<String> {
        aiwb_agents::require_mcp(params.kind)?
            .set_enabled(&params.name, params.enabled)
            .await
    }

    pub(crate) async fn mcp_list_tools(&self, params: McpName) -> ServiceResult<String> {
        aiwb_agents::require_mcp(params.kind)?.list_tools(&params.name).await
    }
}
