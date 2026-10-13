//! 工作区目录一层一层列。以前一次把整棵树收成最多 1500 个文件，
//! 深度优先走到上限后，还没走到的顶层目录就从侧栏消失了。
//! 这里每次只返回一个目录的直接子项，展开哪个目录再读哪一层。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use super::index::FileIndex;
use super::search::{query_indexed_paths, IndexHub};
use super::skip_tree_dir;
use crate::features::projects::ProjectStore;

const FILTER_LIMIT: usize = 4000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TreeEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PathFilter {
    pub paths: Vec<String>,
    pub truncated: bool,
    pub cancelled: bool,
    /// 索引已经覆盖整棵树。还在建索引时为 false，调用方可以接着要下一段。
    pub ready: bool,
}

pub struct FilterHub {
    generation: Arc<AtomicU64>,
}

impl Default for FilterHub {
    fn default() -> Self {
        Self {
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

#[tauri::command]
pub async fn list_project_dir(
    store: State<'_, ProjectStore>,
    project_id: String,
    path: String,
) -> Result<Vec<TreeEntry>, String> {
    let project = store
        .get(&project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    let root = PathBuf::from(&project.path);
    tokio::task::spawn_blocking(move || list_dir_at(&root, &path))
        .await
        .map_err(|err| format!("无法读取目录: {err}"))?
}

#[tauri::command]
pub async fn filter_project_paths(
    store: State<'_, ProjectStore>,
    hub: State<'_, FilterHub>,
    indexes: State<'_, IndexHub>,
    project_id: String,
    query: String,
) -> Result<PathFilter, String> {
    if query.trim().is_empty() {
        return Ok(PathFilter {
            paths: Vec::new(),
            truncated: false,
            cancelled: false,
            ready: true,
        });
    }
    let project = store
        .get(&project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    let root = PathBuf::from(&project.path);
    let generation = hub.generation.clone();
    let ticket = generation.fetch_add(1, Ordering::SeqCst) + 1;
    let indexes = indexes.fork();
    Ok(tokio::task::spawn_blocking(move || {
        let alive = || generation.load(Ordering::SeqCst) == ticket;
        if !alive() {
            return PathFilter {
                paths: Vec::new(),
                truncated: false,
                cancelled: true,
                ready: true,
            };
        }
        let found = query_indexed_paths(&indexes, root, &query, FILTER_LIMIT, alive);
        PathFilter {
            paths: found.paths,
            truncated: found.truncated,
            cancelled: found.cancelled,
            ready: found.ready,
        }
    })
    .await
    .map_err(|err| format!("无法筛选文件: {err}"))?)
}

pub fn list_dir_at(root: &Path, relative: &str) -> Result<Vec<TreeEntry>, String> {
    let dir = resolve_dir(root, relative)?;
    let rel_base = normalize_relative(relative);
    let read = std::fs::read_dir(&dir).map_err(|err| format!("无法读取目录: {err}"))?;
    let mut entries = Vec::new();
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
        let child = if rel_base.is_empty() {
            name.to_string()
        } else {
            format!("{rel_base}/{name}")
        };
        entries.push(TreeEntry {
            name: name.to_string(),
            path: child,
            kind: if is_dir { "dir" } else { "file" }.to_string(),
        });
    }
    entries.sort_by(entry_order);
    Ok(entries)
}

pub fn filter_paths(
    root: &Path,
    query: &str,
    limit: usize,
    alive: impl Fn() -> bool,
) -> PathFilter {
    let query = query.trim();
    if query.is_empty() || limit == 0 || !root.is_dir() {
        return PathFilter {
            paths: Vec::new(),
            truncated: false,
            cancelled: false,
            ready: true,
        };
    }
    if !alive() {
        return PathFilter {
            paths: Vec::new(),
            truncated: false,
            cancelled: true,
            ready: true,
        };
    }
    let mut index = FileIndex::new(root.to_path_buf());
    while !index.complete() {
        if !alive() {
            return PathFilter {
                paths: Vec::new(),
                truncated: false,
                cancelled: true,
                ready: true,
            };
        }
        index.pump_steps(1);
    }
    let (paths, truncated) = index.matching_paths(query, limit);
    PathFilter {
        paths,
        truncated,
        cancelled: false,
        ready: true,
    }
}

fn resolve_dir(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = relative.trim().replace('\\', "/");
    if relative.starts_with('/')
        || (relative.len() >= 2 && relative.as_bytes().get(1) == Some(&b':'))
    {
        return Err("没有这个目录".into());
    }
    let mut dir = root.to_path_buf();
    if !relative.is_empty() && relative != "." {
        for part in relative.split('/') {
            if part.is_empty() || part == "." {
                continue;
            }
            if part == ".." || part.contains('\0') {
                return Err("没有这个目录".into());
            }
            dir.push(part);
        }
    }
    if !dir.is_dir() {
        return Err("没有这个目录".into());
    }
    Ok(dir)
}

fn normalize_relative(relative: &str) -> String {
    relative
        .trim()
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/")
}

fn entry_order(a: &TreeEntry, b: &TreeEntry) -> std::cmp::Ordering {
    match (a.kind == "dir", b.kind == "dir") {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a
            .name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ai-workbench-tree-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn root_lists_every_sibling_and_skips_vendor_dirs() {
        let root = scratch("siblings");
        fs::create_dir_all(root.join("alpha")).unwrap();
        fs::write(root.join("alpha/note.txt"), "x").unwrap();
        fs::create_dir_all(root.join("busy")).unwrap();
        for index in 0..1600 {
            fs::write(root.join("busy").join(format!("f{index}.txt")), "x").unwrap();
        }
        fs::create_dir_all(root.join("zeta")).unwrap();
        fs::write(root.join("zeta/a.txt"), "x").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "x").unwrap();
        fs::create_dir_all(root.join(".github")).unwrap();
        fs::write(root.join(".github/workflows.yml"), "x").unwrap();
        fs::write(root.join(".gitignore"), "x").unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "x").unwrap();

        let top = list_dir_at(&root, "").unwrap();
        let names: Vec<&str> = top.iter().map(|entry| entry.name.as_str()).collect();
        assert!(names.contains(&"alpha"), "{names:?}");
        assert!(names.contains(&"busy"), "{names:?}");
        assert!(names.contains(&"zeta"), "{names:?}");
        assert!(names.contains(&".github"), "{names:?}");
        assert!(names.contains(&".gitignore"), "{names:?}");
        assert!(names
            .iter()
            .all(|name| *name != ".git" && *name != "node_modules"));
        assert!(top.iter().all(|entry| entry.path != "alpha/note.txt"));
        assert!(top.iter().all(|entry| !entry.path.contains("node_modules")));

        let busy = list_dir_at(&root, "busy").unwrap();
        assert_eq!(busy.len(), 1600);
        let alpha = list_dir_at(&root, "alpha").unwrap();
        assert!(alpha.iter().any(|entry| entry.path == "alpha/note.txt"));
        assert!(list_dir_at(&root, "..").is_err());
        assert!(list_dir_at(&root, "alpha/../../etc").is_err());
        assert!(list_dir_at(&root, "/etc").is_err());
        assert!(list_dir_at(&root, "missing").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn filter_finds_files_in_every_top_level_directory() {
        let root = scratch("filter");
        fs::create_dir_all(root.join("alpha")).unwrap();
        fs::create_dir_all(root.join("zeta")).unwrap();
        fs::write(root.join("alpha/keep.ts"), "x").unwrap();
        fs::write(root.join("zeta/keep.ts"), "x").unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/keep.ts"), "x").unwrap();
        fs::create_dir_all(root.join("Library")).unwrap();
        fs::write(root.join("Library/keep.ts"), "x").unwrap();
        let found = filter_paths(&root, "keep.ts", 100, || true);
        assert!(!found.cancelled);
        assert!(!found.truncated);
        assert!(
            found.paths.iter().any(|path| path == "alpha/keep.ts"),
            "{:?}",
            found.paths
        );
        assert!(
            found.paths.iter().any(|path| path == "zeta/keep.ts"),
            "{:?}",
            found.paths
        );
        assert!(found
            .paths
            .iter()
            .all(|path| !path.contains("node_modules")));
        assert!(found.paths.iter().all(|path| !path.starts_with("Library")));
        let cancelled = filter_paths(&root, "keep.ts", 100, || false);
        assert!(cancelled.cancelled);
        assert!(cancelled.paths.is_empty());
        let _ = fs::remove_dir_all(root);
    }
}
