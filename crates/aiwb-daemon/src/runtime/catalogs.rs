//! 每种 Agent 的模型目录：存下的上一份、这次启动后有没有探到新的，以及探的结果。
//! 各 Agent 各探各的，互不等待；同一种 Agent 同一时间只探一次。
//! 照 t3code `apps/server/src/provider/ProviderRegistry.ts`：启动时先用缓存，再逐个刷新并推送状态。
use aiwb_core::models::{CatalogProbe, ProbeStatus};
use aiwb_core::rpc::TOPIC_AGENT_CATALOGS;

use super::*;

fn catalog_key(agent: AgentKind) -> String {
    format!("catalog:{}", agent.as_str())
}

impl Runtimes {
    /// 这种 Agent 上一次成功的模型目录。一次都没拿到过时为空。
    pub(crate) fn stored_catalog(&self, agent: AgentKind) -> RuntimeResult<Option<AgentCatalog>> {
        let raw = self.store.meta(&catalog_key(agent)).map_err(|e| e.to_string())?;
        Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()))
    }

    /// 这次启动后探成功过，就给存下的那份。
    pub(crate) fn fresh_catalog(&self, agent: AgentKind) -> RuntimeResult<Option<AgentCatalog>> {
        let ready = self
            .catalog_probes
            .lock()
            .unwrap()
            .get(&agent)
            .is_some_and(|probe| probe.status == ProbeStatus::Ready);
        if !ready {
            return Ok(None);
        }
        self.stored_catalog(agent)
    }

    /// 各 Agent 探目录的结果，顺序跟着 `AgentKind::all`。
    pub(crate) fn catalog_probes(&self) -> Vec<CatalogProbe> {
        list(&self.catalog_probes.lock().unwrap())
    }

    /// 普通读取复用最近的目录，主动刷新在取得锁后启动新的 CLI。
    pub(crate) async fn refresh_catalog(&self, agent: AgentKind, cwd: String, force: bool) -> RuntimeResult<AgentCatalog> {
        let lock = self.probing.lock().unwrap().entry(agent).or_default().clone();
        let _probing = lock.lock().await;
        if self.closing.load(Ordering::SeqCst) {
            return Err("后台正在退出".to_string());
        }
        if !force {
            if let Some(catalog) = self.fresh_catalog(agent)? {
                return Ok(catalog);
            }
        }
        // 之前失败过的重试期间仍显示失败，出了结果再改。
        self.set_probe(agent, ProbeStatus::Probing, None, |current| force || current.is_none());
        let unless_ready = |current: Option<ProbeStatus>| current != Some(ProbeStatus::Ready);
        match self.probe_catalog(agent, cwd).await {
            Ok(mut catalog) => {
                catalog.thread_model = None;
                catalog.thread_effort = None;
                // 空模型不算探成功：不覆盖存下的目录，也不算就绪。
                if self.store_catalog(agent, &catalog) {
                    self.set_probe(agent, ProbeStatus::Ready, None, |_| true);
                } else {
                    self.set_probe(agent, ProbeStatus::Failed, None, unless_ready);
                }
                Ok(catalog)
            }
            Err(error) => {
                self.set_probe(agent, ProbeStatus::Failed, Some(error.clone()), unless_ready);
                self.stored_catalog(agent)?.ok_or(error)
            }
        }
    }

    /// 公共目录缺失时才使用会话的目录，已有对话可能仍在使用旧版 CLI。
    pub(crate) fn remember_catalog(&self, agent: AgentKind, catalog: &AgentCatalog) {
        self.set_probe(agent, ProbeStatus::Ready, None, |current| {
            matches!(current, None | Some(ProbeStatus::Failed)) && self.store_catalog(agent, catalog)
        });
    }

    /// 各 Agent 独立刷新。升级前已经发出的查询结束后，再向升级后的 CLI 获取目录。
    pub(crate) fn prewarm_catalogs(self: &Arc<Self>, agents: Vec<AgentKind>, cwd: RuntimeResult<String>, force: bool) {
        if self.closing.load(Ordering::SeqCst) {
            return;
        }
        for agent in agents {
            let cwd = match &cwd {
                Ok(cwd) => cwd.clone(),
                Err(error) => {
                    self.set_probe(agent, ProbeStatus::Failed, Some(error.clone()), |current| force || current.is_none());
                    continue;
                }
            };
            let started = self.set_probe(agent, ProbeStatus::Probing, None, |current| force || current.is_none());
            if !force && !started && !self.can_retry(agent) {
                continue;
            }
            let runtimes = self.clone();
            tokio::spawn(async move {
                let _ = runtimes.refresh_catalog(agent, cwd, force).await;
            });
        }
    }

    /// 上次探失败了，而且现在没有在探。
    fn can_retry(&self, agent: AgentKind) -> bool {
        let failed = self
            .catalog_probes
            .lock()
            .unwrap()
            .get(&agent)
            .is_some_and(|probe| probe.status == ProbeStatus::Failed);
        let lock = self.probing.lock().unwrap().entry(agent).or_default().clone();
        failed && lock.try_lock().is_ok()
    }

    /// 线程自己的模型不带给新会话。存下了返回 true。
    fn store_catalog(&self, agent: AgentKind, catalog: &AgentCatalog) -> bool {
        if catalog.models.is_empty() {
            return false;
        }
        let mut stored = catalog.clone();
        stored.thread_model = None;
        serde_json::to_string(&stored)
            .is_ok_and(|raw| self.store.set_meta(&catalog_key(agent), &raw).is_ok())
    }

    /// `allow` 看过现在的状态同意了才改。改了就推送，返回 true。
    fn set_probe(
        &self,
        agent: AgentKind,
        status: ProbeStatus,
        error: Option<String>,
        allow: impl FnOnce(Option<ProbeStatus>) -> bool,
    ) -> bool {
        let next = CatalogProbe { kind: agent, status, error };
        let mut changed = false;
        let _: Result<(), ()> = self.hub.publish_with(TOPIC_AGENT_CATALOGS, || {
            let mut probes = self.catalog_probes.lock().unwrap();
            let current = probes.get(&agent);
            if current == Some(&next) || !allow(current.map(|probe| probe.status)) {
                return Err(());
            }
            probes.insert(agent, next);
            changed = true;
            Ok(((), serde_json::to_value(list(&probes)).unwrap_or_default()))
        });
        changed
    }
}

fn list(probes: &HashMap<AgentKind, CatalogProbe>) -> Vec<CatalogProbe> {
    AgentKind::all()
        .into_iter()
        .filter_map(|kind| probes.get(&kind).cloned())
        .collect()
}
