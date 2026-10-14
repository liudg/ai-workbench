use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::scan::{modified_of, read_children};
use super::{Body, FileIndex, IndexedFile};

const REFRESH_GAP: Duration = Duration::from_secs(2);

impl FileIndex {
    pub(in crate::features::preview) fn refresh(&mut self, budget: Duration) {
        if !self.complete {
            return;
        }
        if self.refresh_queue.is_empty() {
            if self.last_pass.is_some_and(|at| at.elapsed() < REFRESH_GAP) {
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
            self.files
                .retain(|file| !stale_files.iter().any(|rel| rel == &file.rel));
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
