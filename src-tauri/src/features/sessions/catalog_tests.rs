use super::*;
use aiwb_agents::adapter_for;
use aiwb_core::models::{AgentCapabilities, AgentModelOption};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

fn model(id: &str) -> AgentModelOption {
    AgentModelOption {
        id: id.into(),
        label: id.into(),
        description: String::new(),
        is_default: true,
        default_effort: "medium".into(),
        efforts: Vec::new(),
        show_in_picker: true,
        service_tiers: Vec::new(),
        default_service_tier: None,
        resolved_model: String::new(),
    }
}

fn catalog(id: &str) -> AgentCatalog {
    AgentCatalog {
        models: vec![model(id)],
        skills: Vec::new(),
        commands: Vec::new(),
        capabilities: adapter_for(AgentKind::CodexCli).capabilities(),
        skills_error: None,
        configured_model: None,
        configured_effort: None,
        configured_service_tier: None,
        thread_model: None,
        thread_effort: None,
        cli_config_read: None,
        agent: None,
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
fn stale_cached_catalog_keeps_static_worktree_support() {
    let dir =
        std::env::temp_dir().join(format!("ai-workbench-catalog-wt-{}", uuid::Uuid::new_v4()));
    let cache = CatalogCache::load(&dir);
    let mut claude = catalog("opus");
    claude.capabilities.supports_worktree = false;
    claude.capabilities.supports_cancel = false;
    claude.agent = Some(AgentKind::ClaudeCode);
    cache.remember(AgentKind::ClaudeCode, &claude);
    let mut cursor = catalog("cursor");
    cursor.capabilities = AgentCapabilities::none();
    cursor.agent = Some(AgentKind::CursorAgent);
    cache.remember(AgentKind::CursorAgent, &cursor);
    let mut codex = catalog("gpt");
    codex.capabilities.supports_worktree = false;
    codex.capabilities.supports_cancel = false;
    cache.remember(AgentKind::CodexCli, &codex);

    let loaded = CatalogCache::load(&dir);
    assert!(
        loaded
            .get(AgentKind::ClaudeCode)
            .expect("claude")
            .capabilities
            .supports_worktree
    );
    assert!(
        loaded
            .get(AgentKind::CodexCli)
            .expect("codex")
            .capabilities
            .supports_worktree
    );
    assert!(
        !loaded
            .get(AgentKind::CursorAgent)
            .expect("cursor")
            .capabilities
            .supports_worktree
    );
    assert!(
        loaded
            .get(AgentKind::ClaudeCode)
            .expect("claude")
            .capabilities
            .supports_cancel
    );
    assert!(
        loaded
            .get(AgentKind::CodexCli)
            .expect("codex")
            .capabilities
            .supports_cancel
    );
    let cursor_caps = loaded
        .get(AgentKind::CursorAgent)
        .expect("cursor")
        .capabilities;
    assert!(cursor_caps.supports_cancel);
    assert!(!cursor_caps.supports_queue);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn empty_file_is_not_written_over_a_saved_catalog() {
    let dir = std::env::temp_dir().join(format!("ai-workbench-catalog-{}", uuid::Uuid::new_v4()));
    let cache = CatalogCache::load(&dir);
    cache.remember(AgentKind::CodexCli, &catalog("gpt-cached"));
    cache.remember(AgentKind::CodexCli, &AgentCatalog::empty());
    let reloaded = CatalogCache::load(&dir);
    let saved = reloaded.get(AgentKind::CodexCli).expect("persisted");
    assert_eq!(saved.models[0].id, "gpt-cached");
    assert_eq!(saved.agent, Some(AgentKind::CodexCli));
    let foreign = catalog("claude-sonnet");
    let mut foreign = foreign;
    foreign.agent = Some(AgentKind::ClaudeCode);
    cache.remember(AgentKind::CodexCli, &foreign);
    let kept = CatalogCache::load(&dir);
    assert_eq!(
        kept.get(AgentKind::CodexCli).expect("unchanged").models[0].id,
        "gpt-cached"
    );
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
