//! 在打开的工作区目录里搜索文件名和文件内容。
//! 工作台没有接入 Codex 的全文搜索 RPC，这里直接读项目目录。
//! 目录和正文进 `FileIndex` 后，下一次查询不再重走磁盘。索引没建完时按时间片推进。
//! 新的查询会让旧查询直接作废。

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

use super::index::FileIndex;
use crate::features::projects::ProjectStore;
use cursor::SearchCursor;

const SEARCH_LIMIT: usize = 100;
const SEARCH_SLICE: Duration = Duration::from_millis(80);

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
}

impl ProjectEntry {
    fn new(root: PathBuf) -> Self {
        Self {
            index: FileIndex::new(root),
            latest: 0,
            cursor: None,
        }
    }

    fn search_busy(&self) -> bool {
        self.cursor.as_ref().is_some_and(|cursor| !cursor.done)
    }

    fn prepare_index(&mut self, budget: Duration) {
        if !self.search_busy() {
            self.index.refresh(budget);
        }
        self.index.pump_budget(budget);
    }

    fn advance(&mut self, id: u64, query: &str, mask: &str, budget: Duration) -> SearchOutput {
        if id < self.latest {
            return SearchOutput {
                hits: Vec::new(),
                truncated: false,
                done: true,
                cancelled: true,
            };
        }
        self.latest = id;
        let same = self.cursor.as_ref().is_some_and(|cursor| cursor.id == id);
        if !same {
            self.index.refresh(budget);
            self.cursor = Some(SearchCursor::new(id, query, mask, SEARCH_LIMIT));
        }
        let cursor = self.cursor.as_mut().expect("cursor");
        cursor.pump(budget, &mut self.index);
        let output = cursor.snapshot(false);
        if output.done {
            self.cursor = None;
        }
        output
    }
}

fn index_key(root: &Path) -> String {
    root.canonicalize()
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .into_owned()
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
    let mut guard = hub.inner.lock().unwrap_or_else(|err| err.into_inner());
    let entry = guard.entry(key).or_insert_with(|| ProjectEntry::new(root));
    entry.prepare_index(SEARCH_SLICE);
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
    IndexedPaths {
        paths,
        truncated,
        cancelled: false,
        ready,
    }
}

#[tauri::command]
pub async fn search_project_files(
    store: State<'_, ProjectStore>,
    hub: State<'_, IndexHub>,
    project_id: String,
    query: String,
    mask: String,
    search_id: u64,
) -> Result<SearchOutput, String> {
    let project = store
        .get(&project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    let root = PathBuf::from(&project.path);
    let inner = hub.inner.clone();
    tokio::task::spawn_blocking(move || {
        let mut guard = inner.lock().unwrap_or_else(|err| err.into_inner());
        let key = index_key(&root);
        let entry = guard.entry(key).or_insert_with(|| ProjectEntry::new(root));
        entry.advance(search_id, &query, &mask, SEARCH_SLICE)
    })
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
