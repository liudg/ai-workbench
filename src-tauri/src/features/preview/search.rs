//! 在打开的工作区目录里搜索文件名和文件内容。
//! 工作台没有接入 Codex 的全文搜索 RPC，这里直接读项目目录。
//! 每次只扫一小段并记下位置，调用方接着要下一段。这样桌面端不会把整次扫描堵在界面线程上，
//! 新的查询会让旧查询直接作废。

use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use super::skip_tree_dir;
use crate::features::projects::ProjectStore;

const SEARCH_LIMIT: usize = 100;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
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

#[derive(Clone)]
struct Node {
    path: PathBuf,
    rel: String,
    name: String,
    is_dir: bool,
}

struct Frame {
    nodes: Vec<Node>,
    index: usize,
}

struct SearchJob {
    id: u64,
    root: PathBuf,
    query_lower: String,
    mask: String,
    hits: Vec<SearchHit>,
    truncated: bool,
    done: bool,
    stack: Vec<Frame>,
    seen: HashSet<PathBuf>,
    limit: usize,
    opened_root: bool,
}

struct SearchSlot {
    latest: u64,
    job: Option<SearchJob>,
}

pub struct SearchHub {
    slot: Arc<Mutex<SearchSlot>>,
}

impl Default for SearchHub {
    fn default() -> Self {
        Self {
            slot: Arc::new(Mutex::new(SearchSlot {
                latest: 0,
                job: None,
            })),
        }
    }
}

impl SearchJob {
    fn new(id: u64, root: PathBuf, query: &str, mask: &str, limit: usize) -> Self {
        let query_lower = query.trim().to_lowercase();
        let done = query_lower.is_empty() || limit == 0;
        Self {
            id,
            root,
            query_lower,
            mask: mask.to_string(),
            hits: Vec::new(),
            truncated: false,
            done,
            stack: Vec::new(),
            seen: HashSet::new(),
            limit,
            opened_root: done,
        }
    }

    fn pump(&mut self, budget: Duration) {
        if self.done {
            return;
        }
        let start = Instant::now();
        self.ensure_root();
        while !self.done && !self.truncated && start.elapsed() < budget {
            if !self.step() {
                self.done = true;
                break;
            }
        }
        if self.truncated {
            self.done = true;
        }
    }

    #[cfg(test)]
    fn pump_steps(&mut self, steps: usize) {
        if self.done || steps == 0 {
            return;
        }
        self.ensure_root();
        for _ in 0..steps {
            if self.done || self.truncated {
                self.done = true;
                return;
            }
            if !self.step() {
                self.done = true;
                return;
            }
        }
        if self.truncated {
            self.done = true;
        }
    }

    fn ensure_root(&mut self) {
        if self.opened_root || self.done {
            return;
        }
        self.opened_root = true;
        if !self.root.is_dir() {
            self.done = true;
            return;
        }
        let root = self.root.clone();
        self.push_dir(&root, "");
    }

    fn push_dir(&mut self, dir: &Path, rel: &str) {
        let canon = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
        if !self.seen.insert(canon) {
            return;
        }
        let Ok(read) = std::fs::read_dir(dir) else {
            return;
        };
        let mut nodes = Vec::new();
        for entry in read.filter_map(|item| item.ok()) {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }
            let path = entry.path();
            let is_dir = path.is_dir();
            if is_dir && skip_tree_dir(&name) {
                continue;
            }
            if !is_dir && !path.is_file() {
                continue;
            }
            let child_rel = if rel.is_empty() {
                name.to_string()
            } else {
                format!("{rel}/{name}")
            };
            nodes.push(Node {
                path,
                rel: child_rel,
                name: name.to_string(),
                is_dir,
            });
        }
        nodes.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then_with(|| a.name.cmp(&b.name))
        });
        if nodes.is_empty() {
            return;
        }
        self.stack.push(Frame { nodes, index: 0 });
    }

    fn next_node(&mut self) -> Option<Node> {
        loop {
            let exhausted = match self.stack.last() {
                None => return None,
                Some(frame) => frame.index >= frame.nodes.len(),
            };
            if exhausted {
                self.stack.pop();
                continue;
            }
            let frame = self.stack.last_mut().expect("frame");
            let node = frame.nodes[frame.index].clone();
            frame.index += 1;
            return Some(node);
        }
    }

    fn step(&mut self) -> bool {
        if self.truncated {
            return false;
        }
        let Some(node) = self.next_node() else {
            return false;
        };
        if node.is_dir {
            self.push_dir(&node.path, &node.rel);
        } else {
            self.consider_file(&node);
        }
        true
    }

    fn consider_file(&mut self, node: &Node) {
        if self.truncated || !mask_matches(&self.mask, &node.rel) {
            return;
        }
        if contains_ignore_case(&node.name, &self.query_lower) {
            self.push_hit(SearchHit {
                path: node.rel.clone(),
                line: None,
                text: node.name.clone(),
                kind: "name".into(),
            });
        }
        if !self.truncated {
            self.scan_file(&node.path, &node.rel);
        }
    }

    fn scan_file(&mut self, path: &Path, rel: &str) {
        if self.truncated {
            return;
        }
        let Ok(meta) = std::fs::metadata(path) else {
            return;
        };
        if meta.len() > MAX_FILE_BYTES {
            return;
        }
        let mut file = match File::open(path) {
            Ok(file) => file,
            Err(_) => return,
        };
        let mut bytes = Vec::new();
        if file
            .by_ref()
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
        {
            return;
        }
        if bytes.len() as u64 > MAX_FILE_BYTES || bytes.contains(&0) {
            return;
        }
        let Ok(text) = String::from_utf8(bytes) else {
            return;
        };
        for (index, line) in text.split('\n').enumerate() {
            let line = line.trim_end_matches('\r');
            if !contains_ignore_case(line, &self.query_lower) {
                continue;
            }
            let line_no = u32::try_from(index + 1).unwrap_or(u32::MAX);
            if !self.push_hit(SearchHit {
                path: rel.to_string(),
                line: Some(line_no),
                text: snippet(line, &self.query_lower),
                kind: "content".into(),
            }) {
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

fn advance_search(
    slot: &Mutex<SearchSlot>,
    search_id: u64,
    root: PathBuf,
    query: String,
    mask: String,
) -> SearchOutput {
    let mut guard = slot.lock().unwrap_or_else(|err| err.into_inner());
    if search_id < guard.latest {
        return SearchOutput {
            hits: Vec::new(),
            truncated: false,
            done: true,
            cancelled: true,
        };
    }
    guard.latest = search_id;
    if guard.job.as_ref().map(|job| job.id) == Some(search_id) {
        let output = {
            let job = guard.job.as_mut().expect("job");
            job.pump(SEARCH_SLICE);
            job.snapshot(false)
        };
        if output.done {
            guard.job = None;
        }
        return output;
    }
    let mut job = SearchJob::new(search_id, root, &query, &mask, SEARCH_LIMIT);
    job.pump(SEARCH_SLICE);
    let output = job.snapshot(false);
    guard.job = if job.done { None } else { Some(job) };
    output
}

#[tauri::command]
pub async fn search_project_files(
    store: State<'_, ProjectStore>,
    hub: State<'_, SearchHub>,
    project_id: String,
    query: String,
    mask: String,
    search_id: u64,
) -> Result<SearchOutput, String> {
    let project = store
        .get(&project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    let root = PathBuf::from(&project.path);
    let slot = hub.slot.clone();
    Ok(
        tokio::task::spawn_blocking(move || advance_search(&slot, search_id, root, query, mask))
            .await
            .map_err(|err| format!("搜索失败: {err}"))?,
    )
}

#[cfg(test)]
fn search_workspace(root: &Path, query: &str, mask: &str, limit: usize) -> SearchOutput {
    let mut job = SearchJob::new(0, root.to_path_buf(), query, mask, limit);
    let mut guard = 0;
    while !job.done {
        job.pump(Duration::from_secs(30));
        guard += 1;
        if guard > 100_000 {
            job.done = true;
            break;
        }
    }
    job.snapshot(false)
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
        assert!(!job.done, "two steps should not finish this tree");
        let mut guard = 0;
        while !job.done {
            job.pump_steps(3);
            guard += 1;
            assert!(guard < 10_000, "search did not finish");
        }
        assert!(job.hits.iter().any(|hit| hit.path == "z-late/hit.ts"));
        let mut seen = HashSet::new();
        for hit in &job.hits {
            let key = format!("{}:{}:{}", hit.kind, hit.path, hit.line.unwrap_or(0));
            assert!(seen.insert(key), "duplicate hit {}", hit.path);
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_older_search_does_not_replace_a_newer_one() {
        let root = scratch("cancel");
        fs::write(root.join("a.ts"), "log\n").unwrap();
        let slot = Mutex::new(SearchSlot {
            latest: 0,
            job: None,
        });
        let first = advance_search(&slot, 2, root.clone(), "log".into(), "*.ts".into());
        assert!(!first.cancelled);
        assert!(first.hits.iter().any(|hit| hit.path == "a.ts"));
        let stale = advance_search(&slot, 1, root.clone(), "missing".into(), "*.ts".into());
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
