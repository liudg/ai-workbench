//! MCP 管理。参数交给目标实例对应的 CLI（含隔离目录与环境）。

use std::sync::Arc;

use aiwb_agents::McpDriver;
use aiwb_core::models::{default_instance_id, AgentKind, McpAddSpec, McpServerRow, McpSurface};
use serde::Deserialize;

use super::{ServiceResult, Services};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpKind {
    kind: AgentKind,
    #[serde(default)]
    instance_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpAdd {
    kind: AgentKind,
    #[serde(default)]
    instance_id: Option<String>,
    spec: McpAddSpec,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpName {
    kind: AgentKind,
    #[serde(default)]
    instance_id: Option<String>,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpRemove {
    kind: AgentKind,
    #[serde(default)]
    instance_id: Option<String>,
    name: String,
    scope: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpLogin {
    kind: AgentKind,
    #[serde(default)]
    instance_id: Option<String>,
    name: String,
    registration: String,
    scopes: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpEnabled {
    kind: AgentKind,
    #[serde(default)]
    instance_id: Option<String>,
    name: String,
    enabled: bool,
}

impl Services {
    fn mcp_driver_of(
        &self,
        kind: AgentKind,
        instance_id: Option<&str>,
    ) -> ServiceResult<Arc<dyn McpDriver>> {
        let adapter = self.runtimes.adapter_for_instance(kind, instance_id)?;
        if let Some(driver) = adapter.mcp() {
            return Ok(driver);
        }
        Err(aiwb_agents::mcp_surface_for(adapter.as_ref())
            .unavailable_reason
            .unwrap_or_else(|| "暂无法管理 MCP。".into()))
    }

    pub(crate) fn mcp_surfaces(&self) -> Vec<McpSurface> {
        let instances = self.store.list_agent_instances().unwrap_or_default();
        AgentKind::all()
            .into_iter()
            .filter_map(|kind| {
                let inst_id = instances
                    .iter()
                    .find(|inst| inst.kind == kind && inst.is_default)
                    .map(|inst| inst.id.clone())
                    .unwrap_or_else(|| default_instance_id(kind));
                let adapter = self.runtimes.adapter_for_instance(kind, Some(&inst_id)).ok()?;
                Some(aiwb_agents::mcp_surface_for(adapter.as_ref()))
            })
            .collect()
    }

    pub(crate) async fn mcp_list(&self, params: McpKind) -> ServiceResult<Vec<McpServerRow>> {
        self.mcp_driver_of(params.kind, params.instance_id.as_deref())?
            .list()
            .await
    }

    pub(crate) async fn mcp_add(&self, params: McpAdd) -> ServiceResult<String> {
        self.mcp_driver_of(params.kind, params.instance_id.as_deref())?
            .add(&params.spec)
            .await
    }

    pub(crate) async fn mcp_remove(&self, params: McpRemove) -> ServiceResult<String> {
        self.mcp_driver_of(params.kind, params.instance_id.as_deref())?
            .remove(&params.name, &params.scope)
            .await
    }

    pub(crate) async fn mcp_login(&self, params: McpLogin) -> ServiceResult<String> {
        self.mcp_driver_of(params.kind, params.instance_id.as_deref())?
            .login(&params.name, &params.registration, &params.scopes)
            .await
    }

    pub(crate) async fn mcp_logout(&self, params: McpName) -> ServiceResult<String> {
        self.mcp_driver_of(params.kind, params.instance_id.as_deref())?
            .logout(&params.name)
            .await
    }

    pub(crate) async fn mcp_set_enabled(&self, params: McpEnabled) -> ServiceResult<String> {
        self.mcp_driver_of(params.kind, params.instance_id.as_deref())?
            .set_enabled(&params.name, params.enabled)
            .await
    }

    pub(crate) async fn mcp_list_tools(&self, params: McpName) -> ServiceResult<String> {
        self.mcp_driver_of(params.kind, params.instance_id.as_deref())?
            .list_tools(&params.name)
            .await
    }
}
