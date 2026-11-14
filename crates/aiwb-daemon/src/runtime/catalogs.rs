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

    /// 探成功过就直接给；否则起一次 CLI 探出来并记下。探不到时退回存下的目录。
    pub(crate) async fn refresh_catalog(&self, agent: AgentKind, cwd: String) -> RuntimeResult<AgentCatalog> {
        let lock = self.probing.lock().unwrap().entry(agent).or_default().clone();
        let _probing = lock.lock().await;
        if let Some(catalog) = self.fresh_catalog(agent)? {
            return Ok(catalog);
        }
        // 之前失败过的重试期间仍显示失败，出了结果再改。
        self.set_probe(agent, ProbeStatus::Probing, None, |current| current.is_none());
        // 探的时候会话自己的 CLI 可能已经给了目录，那份算数，不改回失败。
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

    /// 会话自己的 CLI 给的目录。空模型不算一次成功，不覆盖已有的目录。
    pub(crate) fn remember_catalog(&self, agent: AgentKind, catalog: &AgentCatalog) {
        if self.store_catalog(agent, catalog) {
            self.set_probe(agent, ProbeStatus::Ready, None, |_| true);
        }
    }

    /// 后台给这些 Agent 各探一次。探成功过或正在探的跳过，失败过的再试。
    pub(crate) fn prewarm_catalogs(self: &Arc<Self>, agents: Vec<AgentKind>, cwd: String) {
        if self.closing.load(Ordering::SeqCst) {
            return;
        }
        for agent in agents {
            let fresh = self.set_probe(agent, ProbeStatus::Probing, None, |current| current.is_none());
            if !fresh && !self.can_retry(agent) {
                continue;
            }
            let runtimes = self.clone();
            let cwd = cwd.clone();
            tokio::spawn(async move {
                let _ = runtimes.refresh_catalog(agent, cwd).await;
            });
        }
    }

    /// 这些 Agent 没法探：还没有结果的记成失败并带上原因。
    pub(crate) fn fail_probes(&self, agents: Vec<AgentKind>, error: &str) {
        for agent in agents {
            self.set_probe(agent, ProbeStatus::Failed, Some(error.to_string()), |current| current.is_none());
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
