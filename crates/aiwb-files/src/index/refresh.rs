use std::collections::HashSet;
use std::time::{Duration, Instant};

use super::scan::{list_children, modified_of};
use super::FileIndex;

const REFRESH_GAP: Duration = Duration::from_secs(2);

impl FileIndex {
    pub(crate) fn refresh(&mut self, budget: Duration) {
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
            return;
        }
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
        self.reads += 1;
        let Some(children) = list_children(&abs, rel) else {
            if !rel.is_empty() {
                self.remove_subtree(rel);
            }
            return;
        };
        if let Some(dir) = self.dirs.iter_mut().find(|dir| dir.rel == rel) {
            dir.mtime = mtime;
        }
        let names: HashSet<&str> = children.iter().map(|child| child.name.as_str()).collect();
        let stale_files: Vec<String> = self
            .files
            .iter()
            .filter(|file| is_direct_child(rel, &file.rel) && !names.contains(file.name.as_str()))
            .map(|file| file.rel.clone())
            .collect();
        for stale in &stale_files {
            self.file_rels.remove(stale);
        }
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
        for child in children {
            if child.is_dir {
                if self.dirs.iter().any(|dir| dir.rel == child.rel) {
                    continue;
                }
                self.enqueue_dir(child.path, child.rel);
                continue;
            }
            self.note_file(child.path, child.rel, child.name);
        }
    }

    fn remove_subtree(&mut self, rel: &str) {
        let prefix = format!("{rel}/");
        let canons: Vec<std::path::PathBuf> = self
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
        let stale: Vec<String> = self
            .files
            .iter()
            .filter(|file| file.rel == rel || file.rel.starts_with(&prefix))
            .map(|file| file.rel.clone())
            .collect();
        for rel in &stale {
            self.file_rels.remove(rel);
        }
        self.files
            .retain(|file| file.rel != rel && !file.rel.starts_with(&prefix));
        self.refresh_queue
            .retain(|dir| dir != rel && !dir.starts_with(&prefix));
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
