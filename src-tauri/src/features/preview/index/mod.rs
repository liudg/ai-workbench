//! 工作区文件索引。文件名筛选和内容搜索共用这一份。
//! 目录只在第一次（以及目录修改时间变了的时候）读取；查询在内存里的路径和已读正文上完成。
//! 新增的目录接着原来的遍历补进索引，不会把已经扫过的树再走一遍。

mod refresh;
mod scan;

use std::collections::{HashSet, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

const MAX_FILE_BYTES: u64 = 1024 * 1024;

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

    pub(in crate::features::preview) fn matching_paths(
        &self,
        query: &str,
        limit: usize,
    ) -> (Vec<String>, bool) {
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
    pub(in crate::features::preview) fn load_text(
        &mut self,
        index: usize,
    ) -> (&str, &str, Option<&str>) {
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

    pub(in crate::features::preview) fn name_matches(
        &self,
        index: usize,
        query_lower: &str,
    ) -> bool {
        !query_lower.is_empty() && self.files[index].name_lower.contains(query_lower)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ai-workbench-index-{name}-{}", std::process::id()));
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
        fs::write(
            root.join("Assets/Scripts/HomeMainView.cs"),
            "class HomeMain {}\n",
        )
        .unwrap();
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
        assert!(
            paths
                .iter()
                .any(|path| path == "Assets/Scripts/HomeMainView.cs"),
            "{paths:?}"
        );
        assert!(
            paths.iter().any(|path| path == "Assets/homeMain.prefab"),
            "{paths:?}"
        );
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
        let (_, _, text) = index.load_text(
            index
                .files
                .iter()
                .position(|file| file.rel == "src/app.cs")
                .unwrap(),
        );
        assert!(text.unwrap().contains("alpha"));
        let reads = index.read_count();
        fs::write(root.join("src/app.cs"), "beta line changed\n").unwrap();
        index.last_pass = None;
        index.last_file_pass = None;
        index.file_cursor = index.files.len();
        index.refresh(Duration::from_secs(5));
        assert!(index.complete());
        assert_eq!(
            index.read_count(),
            reads,
            "editing a file does not reread every directory"
        );
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
            index.read_count(),
            after,
            "a second refresh inside the gap should not reread"
        );
        let _ = fs::remove_dir_all(root);
    }
}
