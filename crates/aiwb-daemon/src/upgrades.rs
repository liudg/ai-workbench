//! 每个 Agent 的官方升级命令。内存状态通过现有 Hub 推送，连接不持有安装进程。
//! 参考 t3code：apps/server/src/provider/providerMaintenanceCommandCoordinator.ts
//! 与 apps/server/src/provider/providerMaintenanceRunner.ts 的内存状态和输出推送。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use aiwb_core::models::{AgentKind, AgentUpgrade, UpgradeStatus};
use aiwb_core::rpc::TOPIC_AGENT_UPGRADES;
use tokio::sync::watch;

use crate::hub::Hub;
use crate::runtime::AdapterFactory;

const OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Default)]
struct State {
    entries: HashMap<AgentKind, AgentUpgrade>,
    installations: HashMap<PathBuf, AgentKind>,
    closing: bool,
}

pub(crate) struct AgentUpgrades {
    state: Mutex<State>,
    hub: Arc<Hub>,
    adapters: AdapterFactory,
    changed: watch::Sender<u64>,
}

impl AgentUpgrades {
    pub(crate) fn new(hub: Arc<Hub>, adapters: AdapterFactory) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            hub,
            adapters,
            changed: watch::channel(0).0,
        })
    }

    pub(crate) fn snapshot(&self) -> Vec<AgentUpgrade> {
        list(&self.state.lock().unwrap_or_else(|e| e.into_inner()))
    }

    pub(crate) fn start(self: &Arc<Self>, kind: AgentKind) -> Result<AgentUpgrade, String> {
        let adapter = (self.adapters)(kind);
        let key = adapter.upgrade_key();
        let (entry, started) = self.hub.publish_with(TOPIC_AGENT_UPGRADES, || {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.closing {
                return Err("后台正在退出，暂时不能更新".to_string());
            }
            if let Some(entry) = state
                .entries
                .get(&kind)
                .filter(|entry| entry.status == UpgradeStatus::Running)
            {
                return Ok((
                    (entry.clone(), false),
                    serde_json::to_value(list(&state)).unwrap(),
                ));
            }
            if let Some(other) = key.as_ref().and_then(|key| state.installations.get(key)) {
                return Err(format!("这份安装正在由 {} 更新", other.display_name()));
            }
            let entry = AgentUpgrade {
                kind,
                status: UpgradeStatus::Running,
                output: String::new(),
                exit_code: None,
                error: None,
            };
            state.entries.insert(kind, entry.clone());
            if let Some(key) = key {
                state.installations.insert(key, kind);
            }
            Ok(((entry, true), serde_json::to_value(list(&state)).unwrap()))
        })?;
        if started {
            let owner = self.clone();
            let updates = self.clone();
            tokio::spawn(async move {
                let output = Arc::new(move |text| updates.append(kind, text));
                let result = adapter.upgrade(output).await.map_err(|e| e.to_string());
                owner.finish(kind, result);
            });
        }
        Ok(entry)
    }

    fn append(&self, kind: AgentKind, text: String) {
        self.change(|state| {
            if let Some(entry) = state.entries.get_mut(&kind) {
                entry.output.push_str(&text);
                if entry.output.len() > OUTPUT_LIMIT {
                    let mut split = entry.output.len() - OUTPUT_LIMIT;
                    while !entry.output.is_char_boundary(split) {
                        split += 1;
                    }
                    entry.output.drain(..split);
                }
            }
        });
    }

    fn finish(&self, kind: AgentKind, result: Result<Option<i32>, String>) {
        self.change(|state| {
            if let Some(entry) = state.entries.get_mut(&kind) {
                match result {
                    Ok(code) => {
                        entry.exit_code = code;
                        entry.status = if code == Some(0) {
                            UpgradeStatus::Succeeded
                        } else {
                            UpgradeStatus::Failed
                        };
                        entry.error = match code {
                            Some(0) => None,
                            Some(code) => Some(format!("更新失败（退出码 {code}）")),
                            None => Some("更新进程异常结束".to_string()),
                        };
                    }
                    Err(error) => {
                        entry.status = UpgradeStatus::Failed;
                        entry.error = Some(error);
                    }
                }
            }
            state.installations.retain(|_, owner| *owner != kind);
        });
        self.changed.send_modify(|revision| *revision += 1);
    }

    fn change(&self, change: impl FnOnce(&mut State)) {
        let _: Result<(), std::convert::Infallible> =
            self.hub.publish_with(TOPIC_AGENT_UPGRADES, || {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                change(&mut state);
                Ok(((), serde_json::to_value(list(&state)).unwrap()))
            });
    }

    pub(crate) fn begin_shutdown(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).closing = true;
    }

    pub(crate) fn running_count(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .values()
            .filter(|entry| entry.status == UpgradeStatus::Running)
            .count()
    }

    /// 正常退出等已有命令结束；不因应用窗口或连接关闭而切断安装。
    pub(crate) async fn wait(&self) {
        let mut changed = self.changed.subscribe();
        while self.running_count() > 0 {
            if changed.changed().await.is_err() {
                break;
            }
        }
    }
}

fn list(state: &State) -> Vec<AgentUpgrade> {
    AgentKind::all()
        .iter()
        .filter_map(|kind| state.entries.get(kind).cloned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiwb_agents::{AgentAdapter, AgentError, UpgradeOutput};
    use aiwb_core::models::AgentCapabilities;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::sync::{Notify, Semaphore};

    struct Installer {
        kind: AgentKind,
        key: PathBuf,
        calls: AtomicUsize,
        started: Notify,
        finish: Semaphore,
        code: i32,
    }

    impl Installer {
        fn new(kind: AgentKind, key: &str, code: i32) -> Arc<Self> {
            Arc::new(Self {
                kind,
                key: key.into(),
                calls: AtomicUsize::new(0),
                started: Notify::new(),
                finish: Semaphore::new(0),
                code,
            })
        }
    }

    #[async_trait::async_trait]
    impl AgentAdapter for Installer {
        fn kind(&self) -> AgentKind {
            self.kind
        }
        fn capabilities(&self) -> AgentCapabilities {
            AgentCapabilities::none()
        }
        fn upgrade_key(&self) -> Option<PathBuf> {
            Some(self.key.clone())
        }
        async fn detect(&self) -> Result<(), AgentError> {
            panic!("upgrade must not probe the CLI")
        }
        async fn upgrade(&self, output: UpgradeOutput) -> Result<Option<i32>, AgentError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            output("native stdout\n".into());
            self.started.notify_one();
            self.finish.acquire().await.unwrap().forget();
            output("native stderr\n".into());
            Ok(Some(self.code))
        }
    }

    #[tokio::test]
    async fn parallel_agents_deduplicate_installations_and_keep_results_for_subscribers() {
        let a = Installer::new(AgentKind::CodexCli, "codex", 0);
        let b = Installer::new(AgentKind::ClaudeCode, "claude", 17);
        let alias = Installer::new(AgentKind::CursorAgent, "codex", 0);
        let adapters: HashMap<_, Arc<dyn AgentAdapter>> = [a.clone(), b.clone(), alias.clone()]
            .into_iter()
            .map(|adapter| (adapter.kind, adapter as Arc<dyn AgentAdapter>))
            .collect();
        let hub = Arc::new(Hub::new());
        let updates =
            AgentUpgrades::new(hub.clone(), Arc::new(move |kind| adapters[&kind].clone()));
        assert_eq!(
            updates.start(a.kind).unwrap().status,
            UpgradeStatus::Running
        );
        assert_eq!(
            updates.start(b.kind).unwrap().status,
            UpgradeStatus::Running
        );
        updates.start(a.kind).unwrap();
        assert!(updates.start(alias.kind).is_err());
        tokio::time::timeout(Duration::from_secs(5), async {
            a.started.notified().await;
            b.started.notified().await;
        })
        .await
        .unwrap();
        assert_eq!(a.calls.load(Ordering::SeqCst), 1);
        assert_eq!(b.calls.load(Ordering::SeqCst), 1);
        assert_eq!(alias.calls.load(Ordering::SeqCst), 0);
        assert!(updates
            .snapshot()
            .iter()
            .all(|entry| entry.status == UpgradeStatus::Running));

        // 没有订阅者时命令照常结束，后来的订阅快照仍然有结果与原始输出。
        a.finish.add_permits(1);
        b.finish.add_permits(1);
        tokio::time::timeout(Duration::from_secs(5), updates.wait())
            .await
            .unwrap();
        hub.snapshot_with(
            || Ok::<_, ()>(serde_json::to_value(updates.snapshot()).unwrap()),
            |_, snapshot| {
                assert_eq!(snapshot[0]["status"], "succeeded");
                assert_eq!(snapshot[0]["exit_code"], 0);
                assert_eq!(snapshot[1]["status"], "failed");
                assert_eq!(snapshot[1]["exit_code"], 17);
                assert_eq!(snapshot[1]["output"], "native stdout\nnative stderr\n");
            },
        )
        .unwrap();
        // 完成后释放安装锁。
        updates.start(alias.kind).unwrap();
        alias.finish.add_permits(1);
        tokio::time::timeout(Duration::from_secs(5), updates.wait())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn shutdown_waits_for_the_command_instead_of_interrupting_it() {
        let installer = Installer::new(AgentKind::CodexCli, "codex", 0);
        let adapter = installer.clone();
        let updates = AgentUpgrades::new(Arc::new(Hub::new()), Arc::new(move |_| adapter.clone()));
        updates.start(installer.kind).unwrap();
        tokio::time::timeout(Duration::from_secs(5), installer.started.notified())
            .await
            .unwrap();
        updates.begin_shutdown();
        assert!(updates.start(installer.kind).is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), updates.wait())
                .await
                .is_err()
        );
        installer.finish.add_permits(1);
        tokio::time::timeout(Duration::from_secs(5), updates.wait())
            .await
            .unwrap();
        assert_eq!(updates.snapshot()[0].status, UpgradeStatus::Succeeded);
    }
}
