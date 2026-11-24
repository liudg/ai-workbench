//! 本机 Agent：安装检测和升级，以及每个实例上一次拿到的模型目录（新会话还没接上 CLI 时用）。

use std::sync::Arc;

use aiwb_core::models::{
    default_instance_id, AgentCatalog, AgentInstallation, AgentKind, AgentUpgrade,
};
use serde::Deserialize;

use super::{ServiceResult, Services};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentParam {
    pub(crate) agent: AgentKind,
    #[serde(default)]
    pub(crate) instance_id: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallationsParam {
    /// 顺带查官方最新版本。要走网络，只有设置页要。
    #[serde(default)]
    check_updates: bool,
    #[serde(default)]
    refresh_catalogs: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeParam {
    pub(crate) agent: AgentKind,
    #[serde(default)]
    pub(crate) instance_id: Option<String>,
    /// 新会话所在的项目。没有时是独立聊天，在任务文件夹里探。
    #[serde(default)]
    pub(crate) project_id: Option<String>,
}

impl Services {
    /// 启动时调用一次：检测本机 Agent，能开会话的已启用实例各探一次模型目录。
    pub fn start_catalog_prewarm(self: &Arc<Self>) {
        let services = Arc::clone(self);
        tokio::spawn(async move {
            services.installations(InstallationsParam::default()).await;
        });
    }

    /// 检测安装时预读模型目录，用户点击「重新检测」时重新读取。
    pub(crate) async fn installations(
        &self,
        params: InstallationsParam,
    ) -> Vec<AgentInstallation> {
        let instances = self.store.list_agent_instances().unwrap_or_default();
        let check_updates = params.check_updates;

        let mut default_handles = Vec::new();
        for kind in AgentKind::all() {
            let def = instances
                .iter()
                .find(|inst| inst.kind == kind && inst.is_default);
            let inst_id = def
                .map(|inst| inst.id.clone())
                .unwrap_or_else(|| default_instance_id(kind));
            let enabled = def.map(|inst| inst.enabled).unwrap_or(true);
            let Ok(adapter) = self.runtimes.adapter_for_instance(kind, Some(&inst_id)) else {
                continue;
            };
            default_handles.push(tokio::spawn(async move {
                let mut item = adapter.installation(check_updates).await;
                if item.instance_id.is_none() {
                    item.instance_id = Some(inst_id.clone());
                }
                (kind, inst_id, enabled, item)
            }));
        }

        let mut list = Vec::new();
        let mut targets: Vec<(AgentKind, String)> = Vec::new();
        for handle in default_handles {
            if let Ok((kind, inst_id, enabled, item)) = handle.await {
                if enabled && item.installed && item.session_linked {
                    targets.push((kind, inst_id));
                }
                list.push(item);
            }
        }

        for inst in instances.into_iter().filter(|inst| !inst.is_default) {
            let Ok(adapter) = self
                .runtimes
                .adapter_for_instance(inst.kind, Some(&inst.id))
            else {
                continue;
            };
            let mut custom_install = adapter.installation(false).await;
            if custom_install.instance_id.is_none() {
                custom_install.instance_id = Some(inst.id.clone());
            }
            if inst.enabled && custom_install.installed && custom_install.session_linked {
                targets.push((inst.kind, inst.id));
            }
            list.push(custom_install);
        }

        if !targets.is_empty() {
            self.runtimes
                .prewarm_instance_catalogs(targets, self.prewarm_dir(), params.refresh_catalogs);
        }
        list
    }

    pub(crate) fn upgrade_agent(&self, params: AgentParam) -> ServiceResult<AgentUpgrade> {
        let agent = params.agent;
        let runtimes = self.runtimes.clone();
        let cwd = self.prewarm_dir();
        self.upgrades
            .start(agent, move || runtimes.prewarm_catalogs(vec![agent], cwd, true))
    }

    /// 预探用的目录：任务文件夹已经有了就用它，没有就用数据目录，不为了探去建它。
    pub(crate) fn prewarm_dir(&self) -> ServiceResult<String> {
        let chats = self.task_folder_path()?;
        let dir = if chats.is_dir() {
            chats
        } else {
            self.worktree_root
                .parent()
                .map(std::path::Path::to_path_buf)
                .ok_or_else(|| "没有可用的目录".to_string())?
        };
        Ok(dir.to_string_lossy().into_owned())
    }

    /// 该实例上一次成功的模型目录。还没有任何会话拿到过时返回空。
    pub(crate) fn cached_catalog(&self, params: AgentParam) -> ServiceResult<Option<AgentCatalog>> {
        self.stored_catalog_for(params.agent, params.instance_id.as_deref())
    }

    pub(crate) fn stored_catalog(&self, agent: AgentKind) -> ServiceResult<Option<AgentCatalog>> {
        self.stored_catalog_for(agent, None)
    }

    pub(crate) fn stored_catalog_for(
        &self,
        agent: AgentKind,
        instance_id: Option<&str>,
    ) -> ServiceResult<Option<AgentCatalog>> {
        self.runtimes.stored_catalog_for(agent, instance_id)
    }

    /// 这次启动后拿到过新目录就直接给；否则起一次 CLI 探出来并记下。探不到时退回存下的目录。
    pub(crate) async fn probe_catalog(&self, params: ProbeParam) -> ServiceResult<AgentCatalog> {
        if let Some(catalog) = self
            .runtimes
            .fresh_catalog_for(params.agent, params.instance_id.as_deref())?
        {
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
            None => self.chat_dir()?,
        };
        self.runtimes
            .refresh_catalog_for(params.agent, params.instance_id, cwd, false)
            .await
    }

    /// 独立聊天的任务文件夹，没有就建出来。
    fn chat_dir(&self) -> ServiceResult<String> {
        let dir = self.task_folder_path()?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建任务文件夹失败：{e}"))?;
        Ok(dir.to_string_lossy().into_owned())
    }
}
