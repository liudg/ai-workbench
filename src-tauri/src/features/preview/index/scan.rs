use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

use super::{DirSnap, FileIndex, Frame, IndexedFile, Node};
use crate::features::preview::skip_tree_dir;

impl FileIndex {
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
}

pub(super) fn read_children(reads: &mut u64, dir: &Path, rel: &str) -> Option<Vec<Node>> {
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

pub(super) fn modified_of(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
}
