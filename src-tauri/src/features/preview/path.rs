//! 预览路径。相对路径相对项目目录，绝对路径按用户打开的位置解析。

use std::path::{Component, Path, PathBuf};

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

/// 目录树和全文搜索都跳过这些目录，避免把依赖和生成物当成工作区内容。
/// 名字按字面匹配：`.git`、`node_modules`、`target`、`dist`、`Library`、`Temp`。
/// 同名目录不会出现，里面的文件也不会被搜到。其它目录，包括点开头的 `.github`，都会列出。
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

pub(super) fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|item| item.to_str())
        .unwrap_or("文件")
        .to_string()
}

pub(super) fn preview_kind(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "html",
        "md" | "markdown" | "mdx" => "markdown",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif" => "image",
        _ => "text",
    }
}
