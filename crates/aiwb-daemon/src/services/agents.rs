//! 本机 Agent：安装检测和升级，以及每种 Agent 上一次拿到的模型目录（新会话还没接上 CLI 时用）。
//! 一次都没拿到过时，在新会话要用的目录里起一次 CLI 探出来。

use aiwb_core::models::{AgentCatalog, AgentInstallation, AgentKind};
use serde::Deserialize;

use super::{ServiceResult, Services};

#[derive(Deserialize)]
pub(crate) struct AgentParam {
    pub(crate) agent: AgentKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallationsParam {
    /// 顺带查官方最新版本。要走网络，只有设置页要。
    #[serde(default)]
    check_updates: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeParam {
    pub(crate) agent: AgentKind,
    /// 新会话所在的项目。没有时是独立聊天，在任务文件夹里探。
    #[serde(default)]
    pub(crate) project_id: Option<String>,
}

fn catalog_key(agent: AgentKind) -> String {
    format!("catalog:{}", agent.as_str())
}

impl Services {
    pub(crate) async fn installations(&self, params: InstallationsParam) -> Vec<AgentInstallation> {
        aiwb_agents::list_installations(params.check_updates).await
    }

    pub(crate) async fn upgrade_agent(&self, params: AgentParam) -> ServiceResult<AgentInstallation> {
        aiwb_agents::upgrade(params.agent).await.map_err(|e| e.to_string())
    }

    /// 这种 Agent 上一次成功的模型目录。还没有任何会话拿到过时返回空。
    pub(crate) fn cached_catalog(&self, params: AgentParam) -> ServiceResult<Option<AgentCatalog>> {
        self.stored_catalog(params.agent)
    }

    fn stored_catalog(&self, agent: AgentKind) -> ServiceResult<Option<AgentCatalog>> {
        let raw = self
            .store
            .meta(&catalog_key(agent))
            .map_err(|e| e.to_string())?;
        Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()))
    }

    /// 已有目录直接给；没有就起一次 CLI 探出来并记下。
    pub(crate) async fn probe_catalog(&self, params: ProbeParam) -> ServiceResult<AgentCatalog> {
        if let Some(catalog) = self.stored_catalog(params.agent)? {
            return Ok(catalog);
        }
        let _probing = self.runtimes.probing.lock().await;
        if let Some(catalog) = self.stored_catalog(params.agent)? {
            return Ok(catalog);
        }
        let cwd = match params.project_id {
            Some(id) => {
                self.store
                    .project(&id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "项目不存在".to_string())?
                    .path
            }
            None => {
                let dir = self.task_folder_path()?;
                std::fs::create_dir_all(&dir).map_err(|e| format!("创建任务文件夹失败：{e}"))?;
                dir.to_string_lossy().into_owned()
            }
        };
        let mut catalog = self.runtimes.probe_catalog(params.agent, cwd).await?;
        catalog.thread_model = None;
        catalog.thread_effort = None;
        self.remember_catalog(params.agent, &catalog);
        Ok(catalog)
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
