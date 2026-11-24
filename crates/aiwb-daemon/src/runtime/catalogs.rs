//! 每个实例 / 每种 Agent 的模型目录：存下的上一份、这次启动后有没有探到新的，以及探的结果。
//! 各实例各探各的，互不等待；同一个实例同一时间只探一次。

use aiwb_core::models::{default_instance_id, effective_instance_id, CatalogProbe, ProbeStatus};
use aiwb_core::rpc::TOPIC_AGENT_CATALOGS;

use super::*;

pub(super) fn instance_key(agent: AgentKind, instance_id: Option<&str>) -> String {
    effective_instance_id(agent, instance_id).to_string()
}

pub(crate) fn non_default_instance_id(agent: AgentKind, key: &str) -> Option<String> {
    (key != default_instance_id(agent)).then(|| key.to_string())
}

fn catalog_meta_key(key: &str) -> String {
    format!("catalog:{key}")
}

fn order_probes_with_ids(
    probes: &HashMap<String, CatalogProbe>,
    instance_ids: &[String],
) -> Vec<CatalogProbe> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for kind in AgentKind::all() {
        let def_key = default_instance_id(kind);
        if let Some(p) = probes.get(&def_key) {
            seen.insert(def_key);
            out.push(p.clone());
        }
    }
    for id in instance_ids {
        if seen.insert(id.clone()) {
            if let Some(p) = probes.get(id) {
                out.push(p.clone());
            }
        }
    }
    let mut extras: Vec<_> = probes
        .iter()
        .filter(|(k, _)| !seen.contains(*k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    extras.sort_by(|a, b| a.0.cmp(&b.0));
    out.extend(extras.into_iter().map(|(_, v)| v));
    out
}

impl Runtimes {
    fn known_instance_ids(&self) -> Vec<String> {
        self.store
            .list_agent_instances()
            .unwrap_or_default()
            .into_iter()
            .map(|inst| inst.id)
            .collect()
    }

    pub(crate) fn stored_catalog_for(
        &self,
        agent: AgentKind,
        instance_id: Option<&str>,
    ) -> RuntimeResult<Option<AgentCatalog>> {
        let key = instance_key(agent, instance_id);
        let raw = self
            .store
            .meta(&catalog_meta_key(&key))
            .map_err(|e| e.to_string())?;
        Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()))
    }

    pub(crate) fn fresh_catalog_for(
        &self,
        agent: AgentKind,
        instance_id: Option<&str>,
    ) -> RuntimeResult<Option<AgentCatalog>> {
        let key = instance_key(agent, instance_id);
        let ready = self
            .catalog_probes
            .lock()
            .unwrap()
            .get(&key)
            .is_some_and(|probe| probe.status == ProbeStatus::Ready);
        if !ready {
            return Ok(None);
        }
        self.stored_catalog_for(agent, Some(&key))
    }

    /// 各实例探目录的结果，先按 `AgentKind::all` 默认实例排，再接自定义实例。
    pub(crate) fn catalog_probes(&self) -> Vec<CatalogProbe> {
        let ids = self.known_instance_ids();
        let probes = self.catalog_probes.lock().unwrap();
        order_probes_with_ids(&probes, &ids)
    }

    pub(crate) fn forget_instance_probe(&self, instance_id: &str) {
        let _ = self.store.delete_meta(&catalog_meta_key(instance_id));
        self.probing.lock().unwrap().remove(instance_id);
        let ids = self.known_instance_ids();
        let _: Result<(), ()> = self.hub.publish_with(TOPIC_AGENT_CATALOGS, || {
            let mut probes = self.catalog_probes.lock().unwrap();
            if probes.remove(instance_id).is_none() {
                return Err(());
            }
            Ok((
                (),
                serde_json::to_value(order_probes_with_ids(&probes, &ids)).unwrap_or_default(),
            ))
        });
    }

    pub(crate) async fn refresh_catalog_for(
        &self,
        agent: AgentKind,
        instance_id: Option<String>,
        cwd: String,
        force: bool,
    ) -> RuntimeResult<AgentCatalog> {
        let key = instance_key(agent, instance_id.as_deref());
        let lock = self
            .probing
            .lock()
            .unwrap()
            .entry(key.clone())
            .or_default()
            .clone();
        let _probing = lock.lock().await;
        if self.closing.load(Ordering::SeqCst) {
            return Err("后台正在退出".to_string());
        }
        if !force {
            if let Some(catalog) = self.fresh_catalog_for(agent, Some(&key))? {
                return Ok(catalog);
            }
        }
        self.set_probe(agent, &key, ProbeStatus::Probing, None, |current| {
            force || current.is_none()
        });
        let unless_ready = |current: Option<ProbeStatus>| current != Some(ProbeStatus::Ready);
        match self.probe_catalog_for(agent, Some(&key), cwd).await {
            Ok(mut catalog) => {
                catalog.thread_model = None;
                catalog.thread_effort = None;
                catalog.instance_id = non_default_instance_id(agent, &key);
                if self.store_catalog_for(agent, &key, &catalog) {
                    self.set_probe(agent, &key, ProbeStatus::Ready, None, |_| true);
                } else {
                    self.set_probe(agent, &key, ProbeStatus::Failed, None, unless_ready);
                }
                Ok(catalog)
            }
            Err(error) => {
                self.set_probe(
                    agent,
                    &key,
                    ProbeStatus::Failed,
                    Some(error.clone()),
                    unless_ready,
                );
                self.stored_catalog_for(agent, Some(&key))?.ok_or(error)
            }
        }
    }

    pub(crate) fn remember_catalog_for(
        &self,
        agent: AgentKind,
        instance_id: Option<&str>,
        catalog: &AgentCatalog,
    ) {
        let key = instance_key(agent, instance_id);
        let should_store = {
            let probes = self.catalog_probes.lock().unwrap();
            matches!(
                probes.get(&key).map(|p| p.status),
                None | Some(ProbeStatus::Failed)
            )
        };
        if !should_store {
            return;
        }
        let mut tagged = catalog.clone();
        tagged.instance_id = non_default_instance_id(agent, &key);
        if !self.store_catalog_for(agent, &key, &tagged) {
            return;
        }
        self.set_probe(agent, &key, ProbeStatus::Ready, None, |current| {
            matches!(current, None | Some(ProbeStatus::Failed))
        });
    }

    pub(crate) fn prewarm_catalogs(
        self: &Arc<Self>,
        agents: Vec<AgentKind>,
        cwd: RuntimeResult<String>,
        force: bool,
    ) {
        let targets: Vec<(AgentKind, String)> = agents
            .into_iter()
            .map(|k| (k, default_instance_id(k)))
            .collect();
        self.prewarm_instance_catalogs(targets, cwd, force);
    }

    pub(crate) fn prewarm_instance_catalogs(
        self: &Arc<Self>,
        targets: Vec<(AgentKind, String)>,
        cwd: RuntimeResult<String>,
        force: bool,
    ) {
        if self.closing.load(Ordering::SeqCst) {
            return;
        }
        for (agent, key) in targets {
            let cwd = match &cwd {
                Ok(cwd) => cwd.clone(),
                Err(error) => {
                    self.set_probe(agent, &key, ProbeStatus::Failed, Some(error.clone()), |current| {
                        force || current.is_none()
                    });
                    continue;
                }
            };
            let started = self.set_probe(agent, &key, ProbeStatus::Probing, None, |current| {
                force || current.is_none()
            });
            if !force && !started && !self.can_retry(&key) {
                continue;
            }
            let runtimes = self.clone();
            tokio::spawn(async move {
                let _ = runtimes
                    .refresh_catalog_for(agent, Some(key), cwd, force)
                    .await;
            });
        }
    }

    fn can_retry(&self, key: &str) -> bool {
        let failed = self
            .catalog_probes
            .lock()
            .unwrap()
            .get(key)
            .is_some_and(|probe| probe.status == ProbeStatus::Failed);
        let lock = self
            .probing
            .lock()
            .unwrap()
            .entry(key.to_string())
            .or_default()
            .clone();
        failed && lock.try_lock().is_ok()
    }

    fn store_catalog_for(&self, agent: AgentKind, key: &str, catalog: &AgentCatalog) -> bool {
        if catalog.models.is_empty() {
            return false;
        }
        let mut stored = catalog.clone();
        stored.thread_model = None;
        stored.instance_id = non_default_instance_id(agent, key);
        serde_json::to_string(&stored)
            .is_ok_and(|raw| self.store.set_meta(&catalog_meta_key(key), &raw).is_ok())
    }

    fn set_probe(
        &self,
        agent: AgentKind,
        key: &str,
        status: ProbeStatus,
        error: Option<String>,
        allow: impl FnOnce(Option<ProbeStatus>) -> bool,
    ) -> bool {
        let next = CatalogProbe {
            kind: agent,
            instance_id: non_default_instance_id(agent, key),
            status,
            error,
        };
        let ids = self.known_instance_ids();
        let mut changed = false;
        let _: Result<(), ()> = self.hub.publish_with(TOPIC_AGENT_CATALOGS, || {
            let mut probes = self.catalog_probes.lock().unwrap();
            let current = probes.get(key);
            if current == Some(&next) || !allow(current.map(|probe| probe.status)) {
                return Err(());
            }
            probes.insert(key.to_string(), next);
            changed = true;
            Ok((
                (),
                serde_json::to_value(order_probes_with_ids(&probes, &ids)).unwrap_or_default(),
            ))
        });
        changed
    }
}
