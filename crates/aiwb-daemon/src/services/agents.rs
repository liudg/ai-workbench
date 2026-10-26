//! 本机 Agent：安装检测和升级，以及每种 Agent 上一次拿到的模型目录（新会话还没接上 CLI 时用）。

use aiwb_core::models::{AgentCatalog, AgentInstallation, AgentKind};
use serde::Deserialize;

use super::{ServiceResult, Services};

#[derive(Deserialize)]
pub(crate) struct AgentParam {
    pub(crate) agent: AgentKind,
}

fn catalog_key(agent: AgentKind) -> String {
    format!("catalog:{}", agent.as_str())
}

impl Services {
    pub(crate) async fn installations(&self) -> Vec<AgentInstallation> {
        aiwb_agents::list_installations().await
    }

    pub(crate) async fn upgrade_agent(&self, params: AgentParam) -> ServiceResult<AgentInstallation> {
        aiwb_agents::upgrade(params.agent).await.map_err(|e| e.to_string())
    }

    /// 这种 Agent 上一次成功的模型目录。还没有任何会话拿到过时返回空。
    pub(crate) fn cached_catalog(&self, params: AgentParam) -> ServiceResult<Option<AgentCatalog>> {
        let raw = self
            .store
            .meta(&catalog_key(params.agent))
            .map_err(|e| e.to_string())?;
        Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()))
    }

    /// 空模型不算一次成功，不覆盖已有的目录。线程自己的模型不带给新会话。
    pub(crate) fn remember_catalog(&self, agent: AgentKind, catalog: &AgentCatalog) {
        if catalog.models.is_empty() {
            return;
        }
        let mut stored = catalog.clone();
        stored.thread_model = None;
        if let Ok(raw) = serde_json::to_string(&stored) {
            let _ = self.store.set_meta(&catalog_key(agent), &raw);
        }
    }
}
