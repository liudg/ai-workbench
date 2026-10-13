//! 在打开的工作区目录里搜索文件名和文件内容。
//! 工作台没有接入 Codex 的全文搜索 RPC，这里直接读项目目录。
//! 目录和正文进 `FileIndex` 后，下一次查询不再重走磁盘。索引没建完时按时间片推进。
//! 新的查询会让旧查询直接作废。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::State;

use super::index::FileIndex;
use crate::features::projects::ProjectStore;

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

struct SearchCursor {
    id: u64,
    query_lower: String,
    mask: String,
    hits: Vec<SearchHit>,
    truncated: bool,
    done: bool,
    limit: usize,
    cursor: usize,
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

impl SearchCursor {
    fn new(id: u64, query: &str, mask: &str, limit: usize) -> Self {
        let query_lower = query.trim().to_lowercase();
        let done = query_lower.is_empty() || limit == 0;
        Self {
            id,
            query_lower,
            mask: mask.to_string(),
            hits: Vec::new(),
            truncated: false,
            done,
            limit,
            cursor: 0,
        }
    }

    fn pump(&mut self, budget: Duration, index: &mut FileIndex) {
        if self.done {
            return;
        }
        let start = std::time::Instant::now();
        while !self.done && start.elapsed() < budget {
            if !self.advance_one(index) {
                self.done = true;
                break;
            }
        }
        if self.truncated {
            self.done = true;
        }
    }

    fn advance_one(&mut self, index: &mut FileIndex) -> bool {
        if self.done || self.truncated {
            self.done = true;
            return false;
        }
        if self.cursor < index.file_count() {
            self.consume(index, self.cursor);
            self.cursor += 1;
            if self.truncated {
                self.done = true;
                return false;
            }
            return true;
        }
        if index.complete() {
            self.done = true;
            return false;
        }
        index.pump_steps(1);
        true
    }

    fn consume(&mut self, index: &mut FileIndex, file_index: usize) {
        if self.truncated {
            return;
        }
        let rel = index.file_rel(file_index).to_string();
        if !mask_matches(&self.mask, &rel) {
            return;
        }
        let name_hit = index.name_matches(file_index, &self.query_lower);
        let query = self.query_lower.clone();
        let mut found = Vec::new();
        {
            let (path, name, text) = index.load_text(file_index);
            if name_hit {
                found.push(SearchHit {
                    path: path.to_string(),
                    line: None,
                    text: name.to_string(),
                    kind: "name".into(),
                });
            }
            if let Some(text) = text {
                let path = path.to_string();
                let room = self.limit.saturating_sub(self.hits.len());
                for (line_index, line) in text.split('\n').enumerate() {
                    let line = line.trim_end_matches('\r');
                    if !contains_ignore_case(line, &query) {
                        continue;
                    }
                    if found.len() >= room {
                        found.push(SearchHit {
                            path: path.clone(),
                            line: None,
                            text: String::new(),
                            kind: "overflow".into(),
                        });
                        break;
                    }
                    let line_no = u32::try_from(line_index + 1).unwrap_or(u32::MAX);
                    found.push(SearchHit {
                        path: path.clone(),
                        line: Some(line_no),
                        text: snippet(line, &query),
                        kind: "content".into(),
                    });
                }
            }
        }
        for hit in found {
            if hit.kind == "overflow" {
                self.truncated = true;
                return;
            }
            if !self.push_hit(hit) {
                return;
            }
        }
    }

    fn push_hit(&mut self, hit: SearchHit) -> bool {
        if self.hits.len() >= self.limit {
            self.truncated = true;
            return false;
        }
        self.hits.push(hit);
        true
    }

    fn snapshot(&self, cancelled: bool) -> SearchOutput {
        SearchOutput {
            hits: self.hits.clone(),
            truncated: self.truncated,
            done: self.done || cancelled,
            cancelled,
        }
    }
}

struct SearchJob {
    index: FileIndex,
    cursor: SearchCursor,
}

impl SearchJob {
    fn new(id: u64, root: PathBuf, query: &str, mask: &str, limit: usize) -> Self {
        Self {
            index: FileIndex::new(root),
            cursor: SearchCursor::new(id, query, mask, limit),
        }
    }

    fn pump(&mut self, budget: Duration) {
        self.cursor.pump(budget, &mut self.index);
    }

    #[cfg(test)]
    fn pump_steps(&mut self, steps: usize) {
        for _ in 0..steps {
            if self.cursor.done {
                return;
            }
            if !self.cursor.advance_one(&mut self.index) {
                self.cursor.done = true;
                return;
            }
        }
    }

    fn snapshot(&self) -> SearchOutput {
        self.cursor.snapshot(false)
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
    Ok(tokio::task::spawn_blocking(move || {
        let mut guard = inner.lock().unwrap_or_else(|err| err.into_inner());
        let key = index_key(&root);
        let entry = guard.entry(key).or_insert_with(|| ProjectEntry::new(root));
        entry.advance(search_id, &query, &mask, SEARCH_SLICE)
    })
    .await
    .map_err(|err| format!("搜索失败: {err}"))?)
}

#[cfg(test)]
fn search_workspace(root: &Path, query: &str, mask: &str, limit: usize) -> SearchOutput {
    let mut job = SearchJob::new(0, root.to_path_buf(), query, mask, limit);
    let mut guard = 0;
    while !job.cursor.done {
        job.pump(Duration::from_secs(30));
        guard += 1;
        if guard > 100_000 {
            job.cursor.done = true;
            break;
        }
    }
    job.snapshot()
}

pub(crate) fn contains_ignore_case(text: &str, query: &str) -> bool {
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

fn mask_matches(mask: &str, relative: &str) -> bool {
    let patterns = split_masks(mask);
    if patterns.is_empty() {
        return true;
    }
    let file_name = relative.rsplit(['/', '\\']).next().unwrap_or(relative);
    patterns.iter().any(|pattern| {
        if pattern == "*" {
            return true;
        }
        let target = if pattern.contains('/') || pattern.contains('\\') {
            relative
        } else {
            file_name
        };
        glob_match(pattern, target)
    })
}

fn split_masks(mask: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut depth: i32 = 0;
    for ch in mask.chars() {
        match ch {
            '{' => {
                depth += 1;
                current.push(ch);
            }
            '}' => {
                depth = depth.saturating_sub(1);
                current.push(ch);
            }
            ',' | ';' if depth == 0 => {
                let piece = current.trim().to_string();
                if !piece.is_empty() {
                    parts.push(piece);
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    let piece = current.trim().to_string();
    if !piece.is_empty() {
        parts.push(piece);
    }
    parts
        .into_iter()
        .flat_map(|part| expand_braces(&part))
        .collect()
}

fn expand_braces(pattern: &str) -> Vec<String> {
    let Some(start) = pattern.find('{') else {
        return vec![pattern.to_string()];
    };
    let Some(end_rel) = pattern[start + 1..].find('}') else {
        return vec![pattern.to_string()];
    };
    let end = start + 1 + end_rel;
    let prefix = &pattern[..start];
    let suffix = &pattern[end + 1..];
    let inner = &pattern[start + 1..end];
    inner
        .split(',')
        .map(|part| format!("{prefix}{}{suffix}", part.trim()))
        .filter(|part| !part.is_empty())
        .collect()
}

fn glob_match(pattern: &str, text: &str) -> bool {
    let pat: Vec<char> = pattern.to_lowercase().chars().collect();
    let text: Vec<char> = text.to_lowercase().chars().collect();
    glob_rec(&pat, &text)
}

fn glob_rec(pat: &[char], text: &[char]) -> bool {
    let mut i = 0;
    let mut j = 0;
    while i < pat.len() {
        if pat[i] == '*' {
            let double = i + 1 < pat.len() && pat[i + 1] == '*';
            i += if double { 2 } else { 1 };
            if i == pat.len() {
                return double || !text[j..].contains(&'/');
            }
            let end = text.len();
            for k in j..=end {
                if !double && text[j..k].contains(&'/') {
                    break;
                }
                if glob_rec(&pat[i..], &text[k..]) {
                    return true;
                }
            }
            return false;
        }
        if j >= text.len() {
            return false;
        }
        if pat[i] == '?' {
            if text[j] == '/' {
                return false;
            }
            i += 1;
            j += 1;
            continue;
        }
        if pat[i] != text[j] {
            return false;
        }
        i += 1;
        j += 1;
    }
    j == text.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ai-workbench-search-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn mask_matches_extensions_braces_and_leaves_other_files() {
        assert!(mask_matches("*.ts", "src/app.ts"));
        assert!(mask_matches("*.ts", "src/App.TS"));
        assert!(!mask_matches("*.ts", "src/app.tsx"));
        assert!(mask_matches("*.{ts,tsx}", "src/app.tsx"));
        assert!(mask_matches("*.ts, *.md", "notes.md"));
        assert!(!mask_matches("*.ts, *.md", "pic.png"));
        assert!(mask_matches("", "pic.png"));
        assert!(mask_matches("*", "pic.png"));
    }

    #[test]
    fn searches_filenames_and_contents_and_skips_vendor_and_binary() {
        let root = scratch("hits");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/app.ts"),
            "export const log = 1;\nconst other = 2;\n",
        )
        .unwrap();
        fs::write(root.join("src/logger.ts"), "export const value = 1;\n").unwrap();
        fs::write(root.join("notes.md"), "log in markdown\n").unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/index.ts"), "log\n").unwrap();
        fs::write(root.join("src/binary.ts"), b"log\0hidden").unwrap();

        let found = search_workspace(&root, "LoG", "*.ts", 100);
        assert!(found.done);
        assert!(!found.cancelled);
        assert!(!found.truncated);
        let labels: Vec<String> = found
            .hits
            .iter()
            .map(|hit| match hit.line {
                Some(line) => format!("{}:{}:{}", hit.kind, hit.path, line),
                None => format!("{}:{}", hit.kind, hit.path),
            })
            .collect();
        assert!(
            labels.iter().any(|item| item == "name:src/logger.ts"),
            "{labels:?}"
        );
        assert!(
            labels.iter().any(|item| item == "content:src/app.ts:1"),
            "{labels:?}"
        );
        assert!(labels.iter().all(|item| !item.contains("notes.md")));
        assert!(labels.iter().all(|item| !item.contains("node_modules")));
        assert!(labels.iter().all(|item| !item.contains("binary")));
        assert!(found.hits.iter().any(|hit| hit.text.contains("log")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn caps_results_at_the_requested_limit() {
        let root = scratch("cap");
        let mut body = String::new();
        for index in 0..120 {
            body.push_str(&format!("log {index}\n"));
        }
        fs::write(root.join("many.ts"), body).unwrap();
        let found = search_workspace(&root, "log", "*.ts", 100);
        assert_eq!(found.hits.len(), 100);
        assert!(found.truncated);
        assert!(found.done);
        assert_eq!(found.hits[0].line, Some(1));
        assert!(search_workspace(&root, "   ", "*.ts", 100).hits.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stepping_reaches_a_match_that_sorts_after_other_directories() {
        let root = scratch("slices");
        fs::create_dir_all(root.join("z-late")).unwrap();
        fs::write(root.join("z-late/hit.ts"), "open\n").unwrap();
        for index in 0..40 {
            let dir = root.join(format!("d{index:02}"));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("skip.ts"), "nothing\n").unwrap();
        }
        let mut job = SearchJob::new(1, root.clone(), "open", "*.ts", 100);
        job.pump_steps(2);
        assert!(!job.cursor.done, "two steps should not finish this tree");
        let mut guard = 0;
        while !job.cursor.done {
            job.pump_steps(3);
            guard += 1;
            assert!(guard < 10_000, "search did not finish");
        }
        assert!(job.cursor.hits.iter().any(|hit| hit.path == "z-late/hit.ts"));
        let mut seen = HashSet::new();
        for hit in &job.cursor.hits {
            let key = format!("{}:{}:{}", hit.kind, hit.path, hit.line.unwrap_or(0));
            assert!(seen.insert(key), "duplicate hit {}", hit.path);
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_older_search_does_not_replace_a_newer_one() {
        let root = scratch("cancel");
        fs::write(root.join("a.ts"), "log\n").unwrap();
        let mut entry = ProjectEntry::new(root.clone());
        let first = entry.advance(2, "log", "*.ts", Duration::from_secs(30));
        assert!(!first.cancelled);
        assert!(first.hits.iter().any(|hit| hit.path == "a.ts"));
        let stale = entry.advance(1, "missing", "*.ts", Duration::from_secs(30));
        assert!(stale.cancelled);
        assert!(stale.done);
        assert!(stale.hits.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn directory_symlink_cycles_do_not_loop() {
        let root = scratch("cycle");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/app.ts"), "log\n").unwrap();
        std::os::unix::fs::symlink(root.join("src"), root.join("src/again")).unwrap();
        let found = search_workspace(&root, "log", "*.ts", 100);
        assert!(found.done);
        assert!(found.hits.iter().any(|hit| hit.path == "src/app.ts"));
        let _ = fs::remove_dir_all(root);
    }
}
