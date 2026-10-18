//! 路径索引和内容搜索是两条通道。
//! 文件名筛选只读内存里的路径，不打开文件。内容搜索单独读正文，并且可以取消。
//! 索引在后台建，查询先返回已经扫到的匹配，扫完后 `ready` / `done` 才为真。

mod content;
mod cursor;
mod mask;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::State;

use self::content::scan_file;
use self::cursor::{ContentPoll, SearchCursor};
use super::index::FileIndex;
use crate::features::projects::ProjectStore;

const SEARCH_LIMIT: usize = 100;
const QUICK_OPEN_LIMIT: usize = 80;
const SEARCH_SLICE: Duration = Duration::from_millis(80);
const SCAN_SLICE: Duration = Duration::from_millis(20);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchHit {
    pub path: String,
    pub line: Option<u32>,
    pub text: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchOutput {
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
    pub done: bool,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IndexedPaths {
    pub paths: Vec<String>,
    pub truncated: bool,
    pub cancelled: bool,
    pub ready: bool,
}

struct ProjectEntry {
    index: FileIndex,
    latest: u64,
    cursor: Option<SearchCursor>,
    scanning: bool,
    content_bytes: u64,
}

pub struct IndexHub {
    inner: Arc<Mutex<HashMap<String, ProjectEntry>>>,
}

impl Default for IndexHub {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl IndexHub {
    pub(crate) fn fork(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }

    pub(crate) fn warm_root(&self, root: PathBuf) {
        let key = index_key(&root);
        {
            let mut guard = lock(&self.inner);
            guard
                .entry(key.clone())
                .or_insert_with(|| ProjectEntry::new(root));
        }
        start_scan(Arc::clone(&self.inner), key);
    }

    #[cfg(test)]
    pub(crate) fn finish_for_test(&self, root: &Path) {
        let key = index_key(root);
        let mut guard = lock(&self.inner);
        let entry = guard
            .entry(key)
            .or_insert_with(|| ProjectEntry::new(root.to_path_buf()));
        let mut guard_count = 0;
        while !entry.index.complete() {
            entry.index.pump_steps(32);
            guard_count += 1;
            assert!(guard_count < 100_000, "index did not finish");
        }
    }

    #[cfg(test)]
    pub(crate) fn content_bytes(&self, root: &Path) -> u64 {
        let key = index_key(root);
        lock(&self.inner)
            .get(&key)
            .map(|entry| entry.content_bytes)
            .unwrap_or(0)
    }

    #[cfg(test)]
    pub(crate) fn index_counts(&self, root: &Path) -> (usize, usize) {
        let key = index_key(root);
        lock(&self.inner)
            .get(&key)
            .map(|entry| (entry.index.file_count(), entry.index.dir_count()))
            .unwrap_or((0, 0))
    }

    #[cfg(test)]
    pub(crate) fn read_count(&self, root: &Path) -> u64 {
        let key = index_key(root);
        lock(&self.inner)
            .get(&key)
            .map(|entry| entry.index.read_count())
            .unwrap_or(0)
    }
}

impl ProjectEntry {
    fn new(root: PathBuf) -> Self {
        Self {
            index: FileIndex::new(root),
            latest: 0,
            cursor: None,
            scanning: false,
            content_bytes: 0,
        }
    }
}

fn lock(
    inner: &Mutex<HashMap<String, ProjectEntry>>,
) -> std::sync::MutexGuard<'_, HashMap<String, ProjectEntry>> {
    inner.lock().unwrap_or_else(|err| err.into_inner())
}

fn index_key(root: &Path) -> String {
    root.canonicalize()
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn start_scan(inner: Arc<Mutex<HashMap<String, ProjectEntry>>>, key: String) {
    {
        let mut guard = lock(&inner);
        let Some(entry) = guard.get_mut(&key) else {
            return;
        };
        if entry.scanning || entry.index.complete() {
            return;
        }
        entry.scanning = true;
    }
    let worker = Arc::clone(&inner);
    let worker_key = key.clone();
    let spawned = std::thread::Builder::new()
        .name("file-index".into())
        .spawn(move || {
            loop {
                let mut guard = lock(&worker);
                let Some(entry) = guard.get_mut(&worker_key) else {
                    break;
                };
                if entry.index.complete() {
                    entry.scanning = false;
                    break;
                }
                entry.index.pump_budget(SCAN_SLICE);
                if entry.index.complete() {
                    entry.scanning = false;
                    break;
                }
                drop(guard);
                // 放下锁之后留出空隙，查询才能读到已经扫到的路径。
                std::thread::sleep(Duration::from_millis(2));
            }
        });
    if spawned.is_err() {
        let mut guard = lock(&inner);
        if let Some(entry) = guard.get_mut(&key) {
            entry.scanning = false;
        }
    }
}

pub(crate) fn query_indexed_paths(
    hub: &IndexHub,
    root: PathBuf,
    query: &str,
    limit: usize,
    alive: impl Fn() -> bool,
) -> IndexedPaths {
    if !alive() {
        return IndexedPaths {
            paths: Vec::new(),
            truncated: false,
            cancelled: true,
            ready: true,
        };
    }
    let key = index_key(&root);
    let (paths, truncated, ready) = {
        let mut guard = lock(&hub.inner);
        let entry = guard
            .entry(key.clone())
            .or_insert_with(|| ProjectEntry::new(root));
        if entry.index.complete() {
            entry.index.refresh(SCAN_SLICE);
        }
        if !alive() {
            return IndexedPaths {
                paths: Vec::new(),
                truncated: false,
                cancelled: true,
                ready: true,
            };
        }
        let ready = entry.index.complete();
        let (paths, truncated) = entry.index.matching_paths(query, limit);
        (paths, truncated, ready)
    };
    if !ready {
        start_scan(Arc::clone(&hub.inner), key);
    }
    IndexedPaths {
        paths,
        truncated,
        cancelled: false,
        ready,
    }
}

pub(crate) fn quick_open_indexed(
    hub: &IndexHub,
    root: PathBuf,
    query: &str,
    limit: usize,
) -> IndexedPaths {
    let key = index_key(&root);
    let (paths, truncated, ready) = {
        let mut guard = lock(&hub.inner);
        let entry = guard
            .entry(key.clone())
            .or_insert_with(|| ProjectEntry::new(root));
        if entry.index.complete() {
            entry.index.refresh(SCAN_SLICE);
        }
        let ready = entry.index.complete();
        let (paths, truncated) = entry.index.quick_open_paths(query, limit);
        (paths, truncated, ready)
    };
    if !ready {
        start_scan(Arc::clone(&hub.inner), key);
    }
    IndexedPaths {
        paths,
        truncated,
        cancelled: false,
        ready,
    }
}

pub(crate) fn search_blocking(
    hub: &IndexHub,
    root: PathBuf,
    query: &str,
    mask: &str,
    search_id: u64,
) -> SearchOutput {
    let key = index_key(&root);
    {
        let mut guard = lock(&hub.inner);
        guard
            .entry(key.clone())
            .or_insert_with(|| ProjectEntry::new(root.clone()));
    }
    start_scan(Arc::clone(&hub.inner), key.clone());
    let started = std::time::Instant::now();
    loop {
        let polled = {
            let mut guard = lock(&hub.inner);
            let Some(entry) = guard.get_mut(&key) else {
                return cancelled_output();
            };
            if search_id < entry.latest {
                return cancelled_output();
            }
            entry.latest = search_id;
            let same = entry
                .cursor
                .as_ref()
                .is_some_and(|cursor| cursor.id == search_id);
            if !same {
                entry.cursor = Some(SearchCursor::new(search_id, query, mask, SEARCH_LIMIT));
            }
            let cursor = entry.cursor.as_mut().expect("cursor");
            if cursor.done {
                return cursor.snapshot(false);
            }
            if cursor.flush_names(&entry.index) {
                return cursor.snapshot(false);
            }
            if started.elapsed() >= SEARCH_SLICE {
                return cursor.snapshot(false);
            }
            match cursor.poll_content(&entry.index) {
                ContentPoll::Rest { done } => {
                    if done {
                        cursor.done = true;
                    }
                    return cursor.snapshot(false);
                }
                ContentPoll::File(file) => file,
            }
        };
        let cursor_query = {
            let guard = lock(&hub.inner);
            guard
                .get(&key)
                .and_then(|entry| entry.cursor.as_ref())
                .filter(|cursor| cursor.id == search_id)
                .map(|cursor| (cursor.room(), cursor.query_lower()))
        };
        let Some((room, query_lower)) = cursor_query else {
            return cancelled_output();
        };
        let outcome = scan_file(&polled.abs, &polled.rel, &query_lower, room);
        let mut guard = lock(&hub.inner);
        let Some(entry) = guard.get_mut(&key) else {
            return cancelled_output();
        };
        if entry.latest != search_id {
            return cancelled_output();
        }
        entry.content_bytes = entry.content_bytes.saturating_add(outcome.bytes);
        let cursor = entry.cursor.as_mut().expect("cursor");
        cursor.commit_content(outcome);
        if cursor.done || started.elapsed() >= SEARCH_SLICE {
            return cursor.snapshot(false);
        }
    }
}

fn cancelled_output() -> SearchOutput {
    SearchOutput {
        hits: Vec::new(),
        truncated: false,
        done: true,
        cancelled: true,
    }
}

#[tauri::command]
pub async fn warm_project_index(
    store: State<'_, ProjectStore>,
    manager: State<'_, crate::features::sessions::SessionManager>,
    hub: State<'_, IndexHub>,
    project_id: String,
    session_id: Option<String>,
) -> Result<(), String> {
    let root = super::project_root(&store, &manager, &project_id, session_id.as_deref())?;
    hub.warm_root(root);
    Ok(())
}

#[tauri::command]
pub async fn quick_open_files(
    store: State<'_, ProjectStore>,
    hub: State<'_, IndexHub>,
    project_id: String,
    query: String,
) -> Result<IndexedPaths, String> {
    let project = store
        .get(&project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    let root = PathBuf::from(&project.path);
    let hub = hub.fork();
    tokio::task::spawn_blocking(move || quick_open_indexed(&hub, root, &query, QUICK_OPEN_LIMIT))
        .await
        .map_err(|err| format!("无法列出文件: {err}"))
}

#[tauri::command]
pub async fn search_project_files(
    store: State<'_, ProjectStore>,
    manager: State<'_, crate::features::sessions::SessionManager>,
    hub: State<'_, IndexHub>,
    project_id: String,
    query: String,
    mask: String,
    search_id: u64,
    session_id: Option<String>,
) -> Result<SearchOutput, String> {
    let root = super::project_root(&store, &manager, &project_id, session_id.as_deref())?;
    let hub = hub.fork();
    tokio::task::spawn_blocking(move || search_blocking(&hub, root, &query, &mask, search_id))
        .await
        .map_err(|err| format!("搜索失败: {err}"))
}

fn contains_ignore_case(text: &str, query: &str) -> bool {
    let query = query.trim();
    if query.is_empty() {
        return false;
    }
    if text.is_ascii() && query.is_ascii() {
        let needle = query.as_bytes();
        let hay = text.as_bytes();
        if needle.len() > hay.len() {
            return false;
        }
        return hay
            .windows(needle.len())
            .any(|window| window.eq_ignore_ascii_case(needle));
    }
    text.to_lowercase().contains(&query.to_lowercase())
}

fn snippet(line: &str, query: &str) -> String {
    const MAX: usize = 160;
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= MAX {
        return line.to_string();
    }
    let lower: String = chars.iter().collect::<String>().to_lowercase();
    let needle = query.to_lowercase();
    let byte_at = lower.find(&needle).unwrap_or(0);
    let start_char = lower[..byte_at].chars().count();
    let needle_chars = needle.chars().count().max(1);
    let from = start_char.saturating_sub(40);
    let mut to = (start_char + needle_chars + 80).min(chars.len());
    if to - from > MAX {
        to = (from + MAX).min(chars.len());
    }
    let mut out: String = chars[from..to].iter().collect();
    if from > 0 {
        out.insert(0, '…');
    }
    if to < chars.len() {
        out.push('…');
    }
    out
}
