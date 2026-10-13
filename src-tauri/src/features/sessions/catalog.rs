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
#[path = "catalog_tests.rs"]
mod tests;
