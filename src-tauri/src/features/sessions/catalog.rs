//! 模型目录的软失败、按 Agent 持久化，以及会话尚未就绪时的一次重试。
//!
//! 适配器仍负责向各自的 CLI 取目录。这里只决定失败时能不能覆盖上一次成功的结果。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::models::{AgentCatalog, AgentKind};

/// 刷新失败但仍有上次成功的目录时，作曲栏只显示这一条弱提示。
pub const CATALOG_STALE_NOTICE: &str = "模型列表刷新失败，仍显示上次的模型。";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCatalogRefresh {
    pub catalog: AgentCatalog,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedAgentCatalog {
    pub kind: AgentKind,
    pub catalog: AgentCatalog,
}

/// `agent_catalog` 赶在 `ensure_events` 之前时，句柄还不在。
pub fn session_not_ready(err: &str) -> bool {
    err == "会话不存在或已结束" || err == "会话不存在"
}

/// 超时、错误，或空模型，都不能覆盖上一次有模型的目录。
pub fn soften_catalog(
    previous: Option<&AgentCatalog>,
    incoming: Result<AgentCatalog, String>,
) -> Result<AgentCatalogRefresh, String> {
    let saved = previous.filter(|catalog| !catalog.models.is_empty());
    match (incoming, saved) {
        (Ok(catalog), _) if !catalog.models.is_empty() => Ok(AgentCatalogRefresh {
            catalog,
            notice: None,
        }),
        (Ok(catalog), None) => Ok(AgentCatalogRefresh {
            catalog,
            notice: None,
        }),
        (Ok(_), Some(previous)) | (Err(_), Some(previous)) => Ok(AgentCatalogRefresh {
            catalog: previous.clone(),
            notice: Some(CATALOG_STALE_NOTICE.to_string()),
        }),
        (Err(err), None) => Err(err),
    }
}

/// 计划开关、调参和权限会赶在 `thread/resume` 结束前发出。
/// 句柄还没有时先等这次打开；没有人在打开，再确保一次。两次之后仍没有，会话才是真的不在。
pub async fn command_when_ready<T, F, Fut, E, EFut>(
    opening: &tokio::sync::Mutex<()>,
    mut attempt: F,
    ensure: E,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
    E: FnOnce() -> EFut,
    EFut: std::future::Future<Output = Result<(), String>>,
{
    match attempt().await {
        Ok(value) => return Ok(value),
        Err(err) if !session_not_ready(&err) => return Err(err),
        Err(_) => {}
    }
    {
        let _guard = opening.lock().await;
        match attempt().await {
            Ok(value) => return Ok(value),
            Err(err) if !session_not_ready(&err) => return Err(err),
            Err(_) => {}
        }
    }
    ensure().await?;
    attempt().await
}

/// 刚 `thread/start` 的线程，以及 8 秒内的目录缓存，都可能暂时列不出它。
/// 第一次没有就刷新后再认一次。
pub fn after_list_refresh<T>(first: Option<T>, refreshed: Option<T>) -> Result<T, &'static str> {
    first.or(refreshed).ok_or("会话不存在")
}

/// 第一次发现会话还没打开时，先 `ensure` 再取一次目录。第二次仍失败就返回，不再循环。
pub async fn catalog_with_ready_retry<T, F, Fut, E, EFut>(
    mut fetch: F,
    ensure: E,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
    E: FnOnce() -> EFut,
    EFut: std::future::Future<Output = Result<(), String>>,
{
    match fetch().await {
        Ok(value) => Ok(value),
        Err(err) if session_not_ready(&err) => {
            ensure().await?;
            fetch().await
        }
        Err(err) => Err(err),
    }
}

/// 每个 Agent 最近一次成功的目录。文件在应用数据目录，重启后作曲栏可以立刻显示。
pub struct CatalogCache {
    file: PathBuf,
    catalogs: Mutex<HashMap<AgentKind, AgentCatalog>>,
}

impl CatalogCache {
    pub fn load(data_dir: &Path) -> Self {
        let _ = fs::create_dir_all(data_dir);
        let file = data_dir.join("catalogs.json");
        let catalogs = fs::read_to_string(&file)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self {
            file,
            catalogs: Mutex::new(catalogs),
        }
    }

    pub fn get(&self, kind: AgentKind) -> Option<AgentCatalog> {
        self.catalogs.lock().unwrap().get(&kind).cloned()
    }

    pub fn list(&self) -> Vec<CachedAgentCatalog> {
        self.catalogs
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, catalog)| !catalog.models.is_empty())
            .map(|(kind, catalog)| CachedAgentCatalog {
                kind: *kind,
                catalog: catalog.clone(),
            })
            .collect()
    }

    /// 空模型不是一次成功的刷新，不能把已有目录写掉。
    pub fn remember(&self, kind: AgentKind, catalog: &AgentCatalog) {
        if catalog.models.is_empty() {
            return;
        }
        let mut catalogs = self.catalogs.lock().unwrap();
        catalogs.insert(kind, catalog.clone());
        if let Ok(raw) = serde_json::to_string_pretty(&*catalogs) {
            let _ = fs::write(&self.file, raw);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::agents::adapter_for;
    use crate::models::AgentModelOption;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn model(id: &str) -> AgentModelOption {
        AgentModelOption {
            id: id.into(),
            label: id.into(),
            description: String::new(),
            is_default: true,
            default_effort: "medium".into(),
            efforts: Vec::new(),
        }
    }

    fn catalog(id: &str) -> AgentCatalog {
        AgentCatalog {
            models: vec![model(id)],
            skills: Vec::new(),
            commands: Vec::new(),
            capabilities: adapter_for(AgentKind::CodexCli).capabilities(),
            skills_error: None,
        }
    }

    #[test]
    fn timeout_keeps_the_previous_models_and_sets_one_notice() {
        let previous = catalog("gpt-cached");
        let refresh = soften_catalog(Some(&previous), Err("等待 Codex model/list 超时".into()))
            .expect("cached catalog");
        assert_eq!(refresh.catalog.models[0].id, "gpt-cached");
        assert_eq!(refresh.notice.as_deref(), Some(CATALOG_STALE_NOTICE));
    }

    #[test]
    fn empty_success_does_not_replace_a_previous_catalog() {
        let previous = catalog("gpt-cached");
        let refresh = soften_catalog(Some(&previous), Ok(AgentCatalog::empty())).expect("kept");
        assert_eq!(refresh.catalog.models[0].id, "gpt-cached");
        assert!(refresh.notice.is_some());
    }

    #[test]
    fn fresh_models_replace_the_cache_without_a_notice() {
        let previous = catalog("gpt-old");
        let refresh = soften_catalog(Some(&previous), Ok(catalog("gpt-new"))).expect("fresh");
        assert_eq!(refresh.catalog.models[0].id, "gpt-new");
        assert!(refresh.notice.is_none());
    }

    #[test]
    fn error_without_a_cache_stays_an_error() {
        let err = soften_catalog(None, Err("等待 Codex model/list 超时".into())).unwrap_err();
        assert!(err.contains("超时"));
    }

    #[test]
    fn empty_file_is_not_written_over_a_saved_catalog() {
        let dir =
            std::env::temp_dir().join(format!("ai-workbench-catalog-{}", uuid::Uuid::new_v4()));
        let cache = CatalogCache::load(&dir);
        cache.remember(AgentKind::CodexCli, &catalog("gpt-cached"));
        cache.remember(AgentKind::CodexCli, &AgentCatalog::empty());
        let reloaded = CatalogCache::load(&dir);
        let saved = reloaded.get(AgentKind::CodexCli).expect("persisted");
        assert_eq!(saved.models[0].id, "gpt-cached");
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn retries_once_after_ensure_when_the_session_is_not_ready() {
        let fetches = AtomicUsize::new(0);
        let ensured = AtomicBool::new(false);
        let result = catalog_with_ready_retry(
            || {
                let attempt = fetches.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt == 0 {
                        Err("会话不存在或已结束".into())
                    } else {
                        Ok("gpt-cached")
                    }
                }
            },
            || async {
                ensured.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await
        .expect("second fetch");
        assert_eq!(result, "gpt-cached");
        assert!(ensured.load(Ordering::SeqCst));
        assert_eq!(fetches.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn does_not_retry_a_timeout_and_does_not_loop_when_still_missing() {
        let timeouts = AtomicUsize::new(0);
        let timeout = catalog_with_ready_retry(
            || {
                timeouts.fetch_add(1, Ordering::SeqCst);
                async { Err::<String, String>("等待 Codex model/list 超时".to_string()) }
            },
            || async { panic!("timeout must not ensure") },
        )
        .await
        .unwrap_err();
        assert!(timeout.contains("超时"));
        assert_eq!(timeouts.load(Ordering::SeqCst), 1);

        let misses = AtomicUsize::new(0);
        let ensured = AtomicUsize::new(0);
        let missing = catalog_with_ready_retry(
            || {
                misses.fetch_add(1, Ordering::SeqCst);
                async { Err::<String, String>("会话不存在或已结束".to_string()) }
            },
            || async {
                ensured.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await
        .unwrap_err();
        assert_eq!(missing, "会话不存在或已结束");
        assert_eq!(ensured.load(Ordering::SeqCst), 1);
        assert_eq!(misses.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn plan_toggle_waits_until_the_in_flight_open_installs_a_handle() {
        let opening = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let guard = opening.lock().await;
        let ready = std::sync::Arc::new(AtomicBool::new(false));
        let flag = ready.clone();
        let gate = opening.clone();
        let task = tokio::spawn(async move {
            command_when_ready(
                &gate,
                || {
                    let flag = flag.clone();
                    async move {
                        if flag.load(Ordering::SeqCst) {
                            Ok("plan")
                        } else {
                            Err("会话不存在或已结束".to_string())
                        }
                    }
                },
                || async { panic!("in-flight open must not ensure again") },
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        ready.store(true, Ordering::SeqCst);
        drop(guard);
        let mode = task.await.expect("join").expect("plan");
        assert_eq!(mode, "plan");
    }

    #[tokio::test]
    async fn missing_session_ensures_once_then_uses_the_handle() {
        let opening = tokio::sync::Mutex::new(());
        let attempts = AtomicUsize::new(0);
        let ensured = AtomicUsize::new(0);
        let mode = command_when_ready(
            &opening,
            || {
                let attempt = attempts.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt < 2 {
                        Err("会话不存在或已结束".to_string())
                    } else {
                        Ok("plan")
                    }
                }
            },
            || async {
                ensured.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await
        .expect("attached");
        assert_eq!(mode, "plan");
        assert_eq!(ensured.load(Ordering::SeqCst), 1);
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_session_that_is_still_missing_after_ensure_stays_missing() {
        let opening = tokio::sync::Mutex::new(());
        let ensured = AtomicUsize::new(0);
        let missing = command_when_ready(
            &opening,
            || async { Err::<(), String>("会话不存在或已结束".to_string()) },
            || async {
                ensured.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await
        .unwrap_err();
        assert_eq!(missing, "会话不存在或已结束");
        assert_eq!(ensured.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_thread_missing_from_the_first_list_is_accepted_after_refresh() {
        let found = after_list_refresh(None, Some("codex-cli:new")).expect("refreshed");
        assert_eq!(found, "codex-cli:new");
        let err = after_list_refresh::<&str>(None, None).unwrap_err();
        assert_eq!(err, "会话不存在");
    }
}
