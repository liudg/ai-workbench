//! 工作区文件索引。文件名筛选和内容搜索共用这一份。
//! 目录只在第一次（以及目录修改时间变了的时候）读取；查询在内存里的路径和已读正文上完成。
//! 新增的目录接着原来的遍历补进索引，不会把已经扫过的树再走一遍。

use std::collections::{HashSet, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use super::skip_tree_dir;

const MAX_FILE_BYTES: u64 = 1024 * 1024;
const REFRESH_GAP: Duration = Duration::from_secs(2);

#[derive(Clone)]
struct Node {
    path: PathBuf,
    rel: String,
    name: String,
    is_dir: bool,
    len: u64,
    modified: Option<SystemTime>,
}

struct Frame {
    nodes: Vec<Node>,
    index: usize,
}

struct DirSnap {
    rel: String,
    abs: PathBuf,
    canon: PathBuf,
    mtime: Option<SystemTime>,
}

enum Body {
    Pending,
    Skip,
    Text(String),
}

pub(in crate::features::preview) struct IndexedFile {
    pub rel: String,
    pub name: String,
    rel_lower: String,
    name_lower: String,
    abs: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
    body: Body,
}

pub(in crate::features::preview) struct FileIndex {
    root: PathBuf,
    files: Vec<IndexedFile>,
    dirs: Vec<DirSnap>,
    stack: Vec<Frame>,
    pending_dirs: VecDeque<(PathBuf, String)>,
    seen: HashSet<PathBuf>,
    opened_root: bool,
    complete: bool,
    refresh_queue: Vec<String>,
    last_pass: Option<Instant>,
    file_cursor: usize,
    last_file_pass: Option<Instant>,
    reads: u64,
}

impl FileIndex {
    pub(in crate::features::preview) fn new(root: PathBuf) -> Self {
        Self {
            root,
            files: Vec::new(),
            dirs: Vec::new(),
            stack: Vec::new(),
            pending_dirs: VecDeque::new(),
            seen: HashSet::new(),
            opened_root: false,
            complete: false,
            refresh_queue: Vec::new(),
            last_pass: None,
            file_cursor: 0,
            last_file_pass: None,
            reads: 0,
        }
    }

    pub(in crate::features::preview) fn complete(&self) -> bool {
        self.complete
    }

    pub(in crate::features::preview) fn file_count(&self) -> usize {
        self.files.len()
    }

    pub(in crate::features::preview) fn file_rel(&self, index: usize) -> &str {
        &self.files[index].rel
    }

    #[cfg(test)]
    pub(in crate::features::preview) fn read_count(&self) -> u64 {
        self.reads
    }

    pub(in crate::features::preview) fn pump_steps(&mut self, steps: usize) {
        for _ in 0..steps {
            if self.complete {
                return;
            }
            if !self.step() {
                self.complete = true;
                return;
            }
        }
    }

    pub(in crate::features::preview) fn pump_budget(&mut self, budget: Duration) {
        if self.complete {
            return;
        }
        let start = Instant::now();
        while !self.complete && start.elapsed() < budget {
            if !self.step() {
                self.complete = true;
                return;
            }
        }
    }

    /// 目录的修改时间变了才重读那一层。未建完时不刷新。
    pub(in crate::features::preview) fn refresh(&mut self, budget: Duration) {
        if !self.complete {
            return;
        }
        if self.refresh_queue.is_empty() {
            if self
                .last_pass
                .is_some_and(|at| at.elapsed() < REFRESH_GAP)
            {
                return;
            }
            self.refresh_queue = self.dirs.iter().map(|dir| dir.rel.clone()).collect();
        }
        let start = Instant::now();
        while start.elapsed() < budget {
            if let Some(rel) = self.refresh_queue.pop() {
                self.refresh_one(&rel);
                if !self.complete {
                    self.refresh_queue.clear();
                    self.last_pass = None;
                    return;
                }
                continue;
            }
            self.last_pass = Some(Instant::now());
            if self.files.is_empty() {
                return;
            }
            if self.file_cursor >= self.files.len() {
                if self
                    .last_file_pass
                    .is_some_and(|at| at.elapsed() < REFRESH_GAP)
                {
                    return;
                }
                self.file_cursor = 0;
                self.last_file_pass = Some(Instant::now());
            }
            self.refresh_file(self.file_cursor);
            self.file_cursor += 1;
        }
    }

    /// 改文件内容不会改父目录的修改时间，所以按文件自己的时间作废正文缓存。
    fn refresh_file(&mut self, index: usize) {
        let abs = self.files[index].abs.clone();
        let meta = std::fs::metadata(&abs).ok();
        let len = meta.as_ref().map(|item| item.len()).unwrap_or(0);
        let modified = meta.as_ref().and_then(|item| item.modified().ok());
        let file = &mut self.files[index];
        if len == file.len && modified == file.modified {
            return;
        }
        file.len = len;
        file.modified = modified;
        file.body = Body::Pending;
    }

    pub(in crate::features::preview) fn matching_paths(&self, query: &str, limit: usize) -> (Vec<String>, bool) {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() || limit == 0 {
            return (Vec::new(), false);
        }
        let mut paths = Vec::new();
        let mut truncated = false;
        for file in &self.files {
            if !file.rel_lower.contains(&needle) {
                continue;
            }
            if paths.len() >= limit {
                truncated = true;
                break;
            }
            paths.push(file.rel.clone());
        }
        (paths, truncated)
    }

    /// 读过的正文留在索引里。二进制和超限文件返回 None。
    pub(in crate::features::preview) fn load_text(&mut self, index: usize) -> (&str, &str, Option<&str>) {
        let file = &mut self.files[index];
        if matches!(file.body, Body::Pending) {
            file.body = read_body(&file.abs, file.len);
        }
        let file = &self.files[index];
        let text = match &file.body {
            Body::Text(text) => Some(text.as_str()),
            Body::Pending | Body::Skip => None,
        };
        (file.rel.as_str(), file.name.as_str(), text)
    }

    pub(in crate::features::preview) fn name_matches(&self, index: usize, query_lower: &str) -> bool {
        !query_lower.is_empty() && self.files[index].name_lower.contains(query_lower)
    }

    fn step(&mut self) -> bool {
        self.ensure_root();
        if self.complete {
            return false;
        }
        if self.stack.is_empty() {
            if let Some((path, rel)) = self.pending_dirs.pop_front() {
                self.push_dir(&path, &rel);
                return true;
            }
            return false;
        }
        let exhausted = self
            .stack
            .last()
            .is_some_and(|frame| frame.index >= frame.nodes.len());
        if exhausted {
            self.stack.pop();
            return true;
        }
        let node = {
            let frame = self.stack.last_mut().expect("frame");
            let node = frame.nodes[frame.index].clone();
            frame.index += 1;
            node
        };
        if node.is_dir {
            self.pending_dirs.push_back((node.path, node.rel));
        } else {
            self.files.push(IndexedFile::from_node(node));
        }
        true
    }

    fn ensure_root(&mut self) {
        if self.opened_root {
            return;
        }
        self.opened_root = true;
        if !self.root.is_dir() {
            self.complete = true;
            return;
        }
        let root = self.root.clone();
        self.push_dir(&root, "");
    }

    fn push_dir(&mut self, dir: &Path, rel: &str) {
        let canon = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
        if !self.seen.insert(canon.clone()) {
            return;
        }
        let mtime = modified_of(dir);
        self.dirs.push(DirSnap {
            rel: rel.to_string(),
            abs: dir.to_path_buf(),
            canon,
            mtime,
        });
        let Some(nodes) = read_children(&mut self.reads, dir, rel) else {
            return;
        };
        if nodes.is_empty() {
            return;
        }
        self.stack.push(Frame { nodes, index: 0 });
    }

    fn refresh_one(&mut self, rel: &str) {
        let Some(pos) = self.dirs.iter().position(|dir| dir.rel == rel) else {
            return;
        };
        let abs = self.dirs[pos].abs.clone();
        let mtime = modified_of(&abs);
        if mtime == self.dirs[pos].mtime {
            return;
        }
        if rel.is_empty() && !abs.is_dir() {
            return;
        }
        let Some(nodes) = read_children(&mut self.reads, &abs, rel) else {
            if !rel.is_empty() {
                self.remove_subtree(rel);
            }
            return;
        };
        if let Some(dir) = self.dirs.iter_mut().find(|dir| dir.rel == rel) {
            dir.mtime = mtime;
        }
        let names: HashSet<&str> = nodes.iter().map(|node| node.name.as_str()).collect();
        let stale_files: Vec<String> = self
            .files
            .iter()
            .filter(|file| is_direct_child(rel, &file.rel) && !names.contains(file.name.as_str()))
            .map(|file| file.rel.clone())
            .collect();
        if !stale_files.is_empty() {
            self.files.retain(|file| !stale_files.iter().any(|rel| rel == &file.rel));
        }
        let stale_dirs: Vec<String> = self
            .dirs
            .iter()
            .filter(|dir| is_direct_child(rel, &dir.rel) && !names.contains(child_name(&dir.rel)))
            .map(|dir| dir.rel.clone())
            .collect();
        for child in stale_dirs {
            self.remove_subtree(&child);
        }
        for node in nodes {
            if node.is_dir {
                if self.dirs.iter().any(|dir| dir.rel == node.rel) {
                    continue;
                }
                self.pending_dirs.push_back((node.path, node.rel));
                self.complete = false;
                continue;
            }
            if let Some(file) = self.files.iter_mut().find(|file| file.rel == node.rel) {
                if file.len != node.len || file.modified != node.modified {
                    file.len = node.len;
                    file.modified = node.modified;
                    file.abs = node.path;
                    file.body = Body::Pending;
                }
                continue;
            }
            self.files.push(IndexedFile::from_node(node));
        }
    }

    fn remove_subtree(&mut self, rel: &str) {
        let prefix = format!("{rel}/");
        let canons: Vec<PathBuf> = self
            .dirs
            .iter()
            .filter(|dir| dir.rel == rel || dir.rel.starts_with(&prefix))
            .map(|dir| dir.canon.clone())
            .collect();
        for canon in canons {
            self.seen.remove(&canon);
        }
        self.dirs
            .retain(|dir| dir.rel != rel && !dir.rel.starts_with(&prefix));
        self.files
            .retain(|file| file.rel != rel && !file.rel.starts_with(&prefix));
        self.refresh_queue
            .retain(|dir| dir != rel && !dir.starts_with(&prefix));
        self.pending_dirs
            .retain(|(_, dir)| dir != rel && !dir.starts_with(&prefix));
    }
}

impl IndexedFile {
    fn from_node(node: Node) -> Self {
        Self {
            rel_lower: node.rel.to_lowercase(),
            name_lower: node.name.to_lowercase(),
            rel: node.rel,
            name: node.name,
            abs: node.path,
            len: node.len,
            modified: node.modified,
            body: Body::Pending,
        }
    }
}

fn read_body(path: &Path, len: u64) -> Body {
    if len > MAX_FILE_BYTES {
        return Body::Skip;
    }
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return Body::Skip,
    };
    let mut bytes = Vec::new();
    if file
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return Body::Skip;
    }
    if bytes.len() as u64 > MAX_FILE_BYTES || bytes.contains(&0) {
        return Body::Skip;
    }
    match String::from_utf8(bytes) {
        Ok(text) => Body::Text(text),
        Err(_) => Body::Skip,
    }
}

fn read_children(reads: &mut u64, dir: &Path, rel: &str) -> Option<Vec<Node>> {
    *reads += 1;
    let read = std::fs::read_dir(dir).ok()?;
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
        let meta = path.metadata().ok();
        let child_rel = if rel.is_empty() {
            name.to_string()
        } else {
            format!("{rel}/{name}")
        };
        nodes.push(Node {
            len: meta.as_ref().map(|item| item.len()).unwrap_or(0),
            modified: meta.as_ref().and_then(|item| item.modified().ok()),
            path,
            rel: child_rel,
            name: name.to_string(),
            is_dir,
        });
    }
    nodes.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });
    Some(nodes)
}

fn modified_of(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|meta| meta.modified()).ok()
}

fn is_direct_child(parent: &str, rel: &str) -> bool {
    if rel.is_empty() || rel == parent {
        return false;
    }
    match rel.rfind('/') {
        Some(index) => &rel[..index] == parent,
        None => parent.is_empty(),
    }
}

fn child_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-workbench-index-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn finish(index: &mut FileIndex) {
        let mut guard = 0;
        while !index.complete() {
            index.pump_steps(8);
            guard += 1;
            assert!(guard < 100_000, "index did not finish");
        }
    }

    #[test]
    fn a_second_query_does_not_reread_directories() {
        let root = scratch("reuse");
        fs::create_dir_all(root.join("Assets/Scripts")).unwrap();
        fs::write(root.join("Assets/Scripts/HomeMainView.cs"), "class HomeMain {}\n").unwrap();
        fs::write(root.join("Assets/homeMain.prefab"), "homemain\n").unwrap();
        fs::create_dir_all(root.join("Library")).unwrap();
        fs::write(root.join("Library/keep.cs"), "homemain\n").unwrap();
        for index in 0..40 {
            let dir = root.join(format!("d{index:02}"));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("skip.cs"), "nothing\n").unwrap();
        }
        let mut index = FileIndex::new(root.clone());
        finish(&mut index);
        let reads = index.read_count();
        assert!(reads > 1, "expected a real walk, got {reads}");
        let (paths, truncated) = index.matching_paths("homemain", 100);
        assert!(!truncated);
        assert!(paths.iter().any(|path| path == "Assets/Scripts/HomeMainView.cs"), "{paths:?}");
        assert!(paths.iter().any(|path| path == "Assets/homeMain.prefab"), "{paths:?}");
        assert!(paths.iter().all(|path| !path.starts_with("Library")));
        let (again, _) = index.matching_paths("HomeMain", 100);
        assert_eq!(again, paths);
        assert_eq!(index.read_count(), reads);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn changed_file_is_reread_and_unchanged_dirs_are_not() {
        let root = scratch("refresh");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/app.cs"), "alpha line\n").unwrap();
        fs::create_dir_all(root.join("other")).unwrap();
        fs::write(root.join("other/note.cs"), "nope\n").unwrap();
        let mut index = FileIndex::new(root.clone());
        finish(&mut index);
        let (_, _, text) = index.load_text(index.files.iter().position(|file| file.rel == "src/app.cs").unwrap());
        assert!(text.unwrap().contains("alpha"));
        let reads = index.read_count();
        fs::write(root.join("src/app.cs"), "beta line changed\n").unwrap();
        index.last_pass = None;
        index.last_file_pass = None;
        index.file_cursor = index.files.len();
        index.refresh(Duration::from_secs(5));
        assert!(index.complete());
        assert_eq!(index.read_count(), reads, "editing a file does not reread every directory");
        let file = index
            .files
            .iter()
            .position(|file| file.rel == "src/app.cs")
            .unwrap();
        let (_, _, text) = index.load_text(file);
        assert!(
            text.unwrap().contains("beta"),
            "cached body should drop after the file changes"
        );
        fs::write(root.join("src/added.cs"), "gamma\n").unwrap();
        if let Some(dir) = index.dirs.iter_mut().find(|dir| dir.rel == "src") {
            dir.mtime = Some(SystemTime::UNIX_EPOCH);
        }
        index.last_pass = None;
        index.refresh(Duration::from_secs(5));
        assert!(
            index.files.iter().any(|file| file.rel == "src/added.cs"),
            "a new file is picked up from the changed directory"
        );
        assert!(index.read_count() > reads);
        assert!(index.read_count() < reads + index.dirs.len() as u64);
        let after = index.read_count();
        index.refresh(Duration::from_secs(5));
        assert_eq!(
            index.read_count(), after,
            "a second refresh inside the gap should not reread"
        );
        let _ = fs::remove_dir_all(root);
    }
}
