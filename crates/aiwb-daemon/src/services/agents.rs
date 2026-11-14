//! 本机 Agent：安装检测和升级，以及每种 Agent 上一次拿到的模型目录（新会话还没接上 CLI 时用）。
//! 存下的目录先给界面用；检测到能开会话的 Agent 就在后台各探一次新的，结果在 `runtime/catalogs.rs`。
//! 目录按 Agent 只存一份，这次启动后探成功过就不再按项目重探。

use std::sync::Arc;

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

impl Services {
    /// 启动时调用一次：检测本机 Agent，能开会话的各探一次模型目录。
    pub fn start_catalog_prewarm(self: &Arc<Self>) {
        let services = Arc::clone(self);
        tokio::spawn(async move {
            services.installations(InstallationsParam { check_updates: false }).await;
        });
    }

    /// 检测到的能开会话的 Agent，还没探成功过模型目录的在后台探。
    pub(crate) async fn installations(&self, params: InstallationsParam) -> Vec<AgentInstallation> {
        let list = aiwb_agents::list_installations(params.check_updates).await;
        let agents: Vec<AgentKind> = list
            .iter()
            .filter(|item| item.installed && item.session_linked)
            .map(|item| item.kind)
            .collect();
        if !agents.is_empty() {
            match self.prewarm_dir() {
                Ok(cwd) => self.runtimes.prewarm_catalogs(agents, cwd),
                Err(err) => self.runtimes.fail_probes(agents, &err),
            }
        }
        list
    }

    /// 预探用的目录：任务文件夹已经有了就用它，没有就用数据目录，不为了探去建它。
    fn prewarm_dir(&self) -> ServiceResult<String> {
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

    /// 这种 Agent 上一次成功的模型目录。还没有任何会话拿到过时返回空。
    pub(crate) fn cached_catalog(&self, params: AgentParam) -> ServiceResult<Option<AgentCatalog>> {
        self.stored_catalog(params.agent)
    }

    pub(crate) fn stored_catalog(&self, agent: AgentKind) -> ServiceResult<Option<AgentCatalog>> {
        self.runtimes.stored_catalog(agent)
    }

    /// 这次启动后拿到过新目录就直接给；否则起一次 CLI 探出来并记下。探不到时退回存下的目录。
    pub(crate) async fn probe_catalog(&self, params: ProbeParam) -> ServiceResult<AgentCatalog> {
        if let Some(catalog) = self.runtimes.fresh_catalog(params.agent)? {
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
        self.runtimes.refresh_catalog(params.agent, cwd).await
    }

    /// 独立聊天的任务文件夹，没有就建出来。
    fn chat_dir(&self) -> ServiceResult<String> {
        let dir = self.task_folder_path()?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建任务文件夹失败：{e}"))?;
        Ok(dir.to_string_lossy().into_owned())
    }
}
