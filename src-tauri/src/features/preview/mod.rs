//! 文件预览。只读文本。相对路径相对项目目录，绝对路径按用户打开的位置读取。
//! 打不开时返回找不到、没有权限或不是文件，不再用「只能预览当前项目」拦住项目外的文件。
//! HTML 另走内置浏览器（`browser`），不经过某个 Agent。

pub mod search;

pub(crate) mod browser;

use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::features::projects::ProjectStore;
use crate::models::strip_verbatim_prefix;

const MAX_PREVIEW_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PreviewDocument {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub text: String,
    pub truncated: bool,
}

#[tauri::command]
pub fn read_preview_file(
    store: State<'_, ProjectStore>,
    project_id: String,
    path: String,
) -> Result<PreviewDocument, String> {
    let project = store
        .get(&project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    read_preview_at(Path::new(&project.path), &path)
}

#[tauri::command]
pub fn open_project_file(
    store: State<'_, ProjectStore>,
    project_id: String,
    path: String,
) -> Result<(), String> {
    let project = store
        .get(&project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    let full = resolve_preview_file(Path::new(&project.path), &path)?;
    let shown = strip_verbatim_prefix(&full.to_string_lossy());
    browser::open_in_shell(&shown)
}

pub fn resolve_preview_file(project_root: &Path, requested: &str) -> Result<PathBuf, String> {
    let candidate = candidate_path(project_root, requested)?;
    if candidate.is_dir() {
        return Err("不是文件".into());
    }
    let full = match candidate.canonicalize() {
        Ok(real) => real,
        Err(_) if candidate.is_file() => candidate,
        Err(err) => return Err(read_error(&candidate, &err)),
    };
    if full.is_dir() {
        return Err("不是文件".into());
    }
    if !full.is_file() {
        return Err("找不到文件".into());
    }
    Ok(full)
}

fn read_error(path: &Path, err: &std::io::Error) -> String {
    if path.is_dir() {
        return "不是文件".into();
    }
    match err.kind() {
        std::io::ErrorKind::NotFound => "找不到文件".into(),
        std::io::ErrorKind::PermissionDenied => format!("无法读取文件: {err}"),
        _ if !path.exists() => "找不到文件".into(),
        _ => format!("无法读取文件: {err}"),
    }
}

pub fn read_preview_at(project_root: &Path, requested: &str) -> Result<PreviewDocument, String> {
    let full = resolve_preview_file(project_root, requested)?;
    let mut file = File::open(&full).map_err(|err| format!("无法读取文件: {err}"))?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take((MAX_PREVIEW_BYTES as u64) + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("无法读取文件: {err}"))?;
    let truncated = bytes.len() > MAX_PREVIEW_BYTES;
    if truncated {
        bytes.truncate(MAX_PREVIEW_BYTES);
    }
    let shown = strip_verbatim_prefix(&full.to_string_lossy());
    let name = full
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or("文件")
        .to_string();
    if bytes.contains(&0) {
        return Ok(PreviewDocument {
            path: shown,
            name,
            kind: "binary".into(),
            text: String::new(),
            truncated: false,
        });
    }
    Ok(PreviewDocument {
        path: shown,
        name,
        kind: preview_kind(&full).into(),
        text: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
    })
}

const MAX_TREE_FILES: usize = 1500;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProjectTree {
    pub root: String,
    pub paths: Vec<String>,
}

#[tauri::command]
pub fn list_project_tree(
    store: State<'_, ProjectStore>,
    project_id: String,
) -> Result<ProjectTree, String> {
    let project = store
        .get(&project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    Ok(list_tree_at(Path::new(&project.path)))
}

pub fn list_tree_at(root: &Path) -> ProjectTree {
    let mut paths = Vec::new();
    if root.is_dir() {
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(read) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut entries: Vec<_> = read.filter_map(|item| item.ok()).collect();
            entries.sort_by_key(|item| item.file_name());
            for entry in entries {
                let path = entry.path();
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if path.is_dir() {
                    if skip_tree_dir(&name) {
                        continue;
                    }
                    stack.push(path);
                    continue;
                }
                if !path.is_file() {
                    continue;
                }
                let Ok(rel) = path.strip_prefix(root) else {
                    continue;
                };
                paths.push(rel.to_string_lossy().replace('\\', "/"));
                if paths.len() >= MAX_TREE_FILES {
                    break;
                }
            }
            if paths.len() >= MAX_TREE_FILES {
                break;
            }
        }
    }
    paths.sort();
    ProjectTree {
        root: strip_verbatim_prefix(&root.to_string_lossy()).to_string(),
        paths,
    }
}

pub(crate) fn skip_tree_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "Library" | "Temp"
    )
}

fn candidate_path(project_root: &Path, requested: &str) -> Result<PathBuf, String> {
    let trimmed = requested.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("没有文件路径".into());
    }
    let decoded = file_url_path(trimmed).unwrap_or_else(|| trimmed.to_string());
    let without_query = decoded.split(['?', '#']).next().unwrap_or(decoded.as_str());
    let path = Path::new(without_query);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        project_root.join(path)
    };
    Ok(lexical_normalize(&joined))
}

fn file_url_path(value: &str) -> Option<String> {
    let rest = value.strip_prefix("file:")?;
    let rest = rest.trim_start_matches('/');
    if rest.len() >= 2 && rest.as_bytes()[1] == b':' {
        return Some(rest.replace('/', "\\"));
    }
    if value.starts_with("file:///") {
        let path = value.trim_start_matches("file:///").replace('/', "\\");
        if path.len() >= 2 && path.as_bytes()[1] == b':' {
            return Some(path);
        }
    }
    None
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

fn preview_kind(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "html",
        "md" | "markdown" | "mdx" => "markdown",
        _ => "text",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-workbench-preview-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_html_markdown_and_text_inside_the_project() {
        let root = scratch("kinds");
        fs::write(root.join("index.html"), "<p>preview-marker</p>").unwrap();
        fs::write(root.join("notes.md"), "# 笔记").unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src").join("app.ts"), "export {}\n").unwrap();

        let html = read_preview_at(&root, "index.html").unwrap();
        assert_eq!(html.kind, "html");
        assert!(html.text.contains("preview-marker"));

        let markdown = read_preview_at(&root, "notes.md").unwrap();
        assert_eq!(markdown.kind, "markdown");
        assert!(markdown.text.contains("笔记"));

        let text = read_preview_at(&root, "src/app.ts").unwrap();
        assert_eq!(text.kind, "text");
        assert!(text.text.contains("export"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_files_outside_the_project_when_the_os_allows_it() {
        let root = scratch("outside");
        let outside = root.with_file_name(format!(
            "{}-out",
            root.file_name().unwrap().to_string_lossy()
        ));
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "outside-marker").unwrap();
        fs::write(root.join("ok.txt"), "yes").unwrap();
        fs::create_dir(root.join("subdir")).unwrap();

        let sibling = outside.join("secret.txt");
        let absolute = read_preview_at(&root, sibling.to_str().unwrap()).unwrap();
        assert!(absolute.text.contains("outside-marker"), "{}", absolute.text);
        let relative = format!("../{}/secret.txt", outside.file_name().unwrap().to_string_lossy());
        let escaped = read_preview_at(&root, &relative).unwrap();
        assert!(escaped.text.contains("outside-marker"), "{}", escaped.text);
        assert!(read_preview_at(&root, "ok.txt").unwrap().text.contains("yes"));
        let missing = read_preview_at(&root, "missing.txt").unwrap_err();
        assert!(missing.contains("找不到"), "{missing}");
        assert!(!missing.contains("只能预览"), "{missing}");
        let directory = read_preview_at(&root, "subdir").unwrap_err();
        assert!(directory.contains("不是文件"), "{directory}");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn reads_a_symlink_that_points_outside_the_project() {
        let root = scratch("link");
        let outside = scratch("link-out");
        fs::write(outside.join("secret.txt"), "linked-marker").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("linked.txt")).unwrap();
        let doc = read_preview_at(&root, "linked.txt").unwrap();
        assert!(doc.text.contains("linked-marker"), "{}", doc.text);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn lists_workspace_files_and_skips_vendor_dirs() {
        let root = scratch("tree");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src").join("app.ts"), "export {}\n").unwrap();
        fs::create_dir_all(root.join("node_modules").join("pkg")).unwrap();
        fs::write(root.join("node_modules").join("pkg").join("index.js"), "nope").unwrap();
        let tree = list_tree_at(&root);
        assert!(tree.paths.iter().any(|path| path == "src/app.ts"));
        assert!(tree.paths.iter().all(|path| !path.contains("node_modules")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_the_operator_preview_directory_when_set() {
        let Ok(root) = std::env::var("AI_WORKBENCH_PREVIEW_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let html = read_preview_at(&root, "index.html").expect("index.html");
        assert_eq!(html.kind, "html");
        assert!(html.text.contains("preview-marker"), "{}", html.text);
        assert_eq!(read_preview_at(&root, "notes.md").unwrap().kind, "markdown");
        assert_eq!(read_preview_at(&root, "readme.txt").unwrap().kind, "text");
        match read_preview_at(&root, r"..\secret.txt") {
            Ok(_) => {}
            Err(err) => {
                assert!(!err.contains("只能预览"), "{err}");
                assert!(
                    err.contains("找不到") || err.contains("无法读取") || err.contains("不是文件"),
                    "{err}"
                );
            }
        }
    }
}
