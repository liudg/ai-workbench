use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use ignore::WalkBuilder;

use super::{Child, DirSnap, FileIndex, IndexedFile};
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
        self.ensure_started();
        if self.complete {
            return false;
        }
        loop {
            if self.walks.is_empty() {
                self.complete = true;
                return false;
            }
            let next = self.walks.front_mut().and_then(|walk| walk.next());
            match next {
                Some(Ok(entry)) => {
                    self.record(&entry);
                    return true;
                }
                Some(Err(_)) => return true,
                None => {
                    self.walks.pop_front();
                }
            }
        }
    }

    fn ensure_started(&mut self) {
        if self.started {
            return;
        }
        self.started = true;
        if !self.root.is_dir() {
            self.complete = true;
            return;
        }
        let root = self.root.clone();
        self.walks.push_back(walker(&root).build());
    }

    fn record(&mut self, entry: &ignore::DirEntry) {
        let Some(is_dir) = classify(entry) else {
            return;
        };
        let path = plain_path(entry.path());
        let Some(rel) = relative_to(&self.root, &path) else {
            return;
        };
        if is_dir {
            self.note_dir(path, rel);
            return;
        }
        if rel.is_empty() {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        self.note_file(path, rel, name);
    }

    pub(super) fn note_dir(&mut self, abs: PathBuf, rel: String) {
        let canon = abs.canonicalize().unwrap_or_else(|_| abs.clone());
        if !self.seen.insert(canon.clone()) {
            return;
        }
        self.reads += 1;
        let mtime = modified_of(&abs);
        self.dirs.push(DirSnap {
            rel,
            abs,
            canon,
            mtime,
        });
    }

    pub(super) fn note_file(&mut self, abs: PathBuf, rel: String, name: String) {
        if rel.is_empty() || !self.file_rels.insert(rel.clone()) {
            return;
        }
        self.files.push(IndexedFile::create(abs, rel, name));
    }

    pub(super) fn enqueue_dir(&mut self, abs: PathBuf, rel: String) {
        let canon = abs.canonicalize().unwrap_or_else(|_| abs.clone());
        if self.seen.contains(&canon) {
            return;
        }
        self.note_dir(abs.clone(), rel);
        if abs.is_dir() {
            self.walks.push_back(walker(&abs).build());
            self.complete = false;
        }
    }
}

pub(super) fn walker(root: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .ignore(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| allow(entry));
    builder
}

pub(super) fn list_children(dir: &Path, parent_rel: &str) -> Option<Vec<Child>> {
    if !dir.is_dir() {
        return None;
    }
    let mut children = Vec::new();
    let mut saw_root = false;
    for item in walker(dir).max_depth(Some(1)).build() {
        let entry = match item {
            Ok(entry) => entry,
            Err(_) if !saw_root => return None,
            Err(_) => continue,
        };
        if entry.depth() == 0 {
            saw_root = true;
            continue;
        }
        let Some(is_dir) = classify(&entry) else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let rel = if parent_rel.is_empty() {
            name.clone()
        } else {
            format!("{parent_rel}/{name}")
        };
        children.push(Child {
            name,
            rel,
            path: plain_path(entry.path()),
            is_dir,
        });
    }
    if !saw_root {
        return None;
    }
    children.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });
    Some(children)
}

fn allow(entry: &ignore::DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    let name = entry.file_name().to_string_lossy();
    if name.is_empty() || name == "." || name == ".." {
        return false;
    }
    match classify(entry) {
        Some(true) => !skip_tree_dir(&name),
        Some(false) => true,
        None => false,
    }
}

fn classify(entry: &ignore::DirEntry) -> Option<bool> {
    let kind = entry.file_type()?;
    if kind.is_dir() {
        return Some(true);
    }
    if kind.is_file() || (kind.is_symlink() && entry.path().is_file()) {
        return Some(false);
    }
    None
}

fn relative_to(root: &Path, path: &Path) -> Option<String> {
    let root = plain_path(root);
    let path = plain_path(path);
    if path == root {
        return Some(String::new());
    }
    path.strip_prefix(&root).ok().map(|rel| {
        rel.components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/")
    })
}

fn plain_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    let stripped = text
        .strip_prefix(r"\\?\")
        .or_else(|| text.strip_prefix("//?/"))
        .unwrap_or(text.as_ref());
    PathBuf::from(stripped)
}

pub(super) fn modified_of(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
}
