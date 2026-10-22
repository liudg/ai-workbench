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
    let normalized = normalize_requested_path(requested);
    if normalized.is_empty() {
        return Err("没有文件路径".into());
    }
    let path = Path::new(&normalized);
    let joined = if is_request_absolute(&normalized) || path.is_absolute() {
        path.to_path_buf()
    } else {
        project_root.join(path)
    };
    Ok(lexical_normalize(&joined))
}

/// 聊天链接和 file 地址收成磁盘路径。`</C:/...>` 剥掉尖括号后是 `/C:/...`，不能当成 Unix 根路径。
fn normalize_requested_path(requested: &str) -> String {
    let trimmed = requested.trim().trim_matches('"').trim();
    let unwrapped = unwrap_angles(trimmed);
    let extracted = file_url_path(unwrapped).unwrap_or_else(|| unwrapped.to_string());
    let without_query = extracted
        .split(['?', '#'])
        .next()
        .unwrap_or(extracted.as_str())
        .trim();
    // Codex 的 `file.cs:648`、`:648:12`、`:648-660` 不是文件名。`#L` 已在上面随 `#` 去掉。
    let without_line = strip_line_suffix(without_query);
    strip_spurious_drive_slash(without_line)
}

/// 末尾的 `:line`、`:line:col`、`:line-line`、`:line:col-line:col`。盘符冒号不在末尾，留着。
fn strip_line_suffix(value: &str) -> &str {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b':' && colon_location_suffix(&value[index..]) {
            let path = &value[..index];
            if !path.is_empty() && !path.ends_with(['/', '\\']) {
                return path;
            }
        }
        index += 1;
    }
    value
}

fn colon_location_suffix(tail: &str) -> bool {
    let Some(mut rest) = tail.strip_prefix(':') else {
        return false;
    };
    let Some((_line, next)) = take_positive_line(rest) else {
        return false;
    };
    rest = next;
    if let Some(after_colon) = rest.strip_prefix(':') {
        let Some((_col, next)) = take_u32(after_colon) else {
            return false;
        };
        rest = next;
    }
    if rest.is_empty() {
        return true;
    }
    let Some(after_dash) = rest.strip_prefix('-') else {
        return false;
    };
    let Some((_end, next)) = take_positive_line(after_dash) else {
        return false;
    };
    rest = next;
    if let Some(after_colon) = rest.strip_prefix(':') {
        let Some((_col, next)) = take_u32(after_colon) else {
            return false;
        };
        rest = next;
    }
    rest.is_empty()
}

fn take_positive_line(input: &str) -> Option<(u32, &str)> {
    let (line, rest) = take_u32(input)?;
    if line < 1 {
        return None;
    }
    Some((line, rest))
}

fn take_u32(input: &str) -> Option<(u32, &str)> {
    let end = input
        .bytes()
        .position(|byte| !byte.is_ascii_digit())
        .unwrap_or(input.len());
    if end == 0 {
        return None;
    }
    let line = input[..end].parse::<u32>().ok()?;
    Some((line, &input[end..]))
}

fn unwrap_angles(value: &str) -> &str {
    let value = value.trim();
    if value.len() >= 2 && value.starts_with('<') && value.ends_with('>') {
        return value[1..value.len() - 1].trim();
    }
    value
}

fn strip_spurious_drive_slash(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 4
        && (bytes[0] == b'/' || bytes[0] == b'\\')
        && bytes[1].is_ascii_alphabetic()
        && bytes[2] == b':'
        && (bytes[3] == b'/' || bytes[3] == b'\\')
    {
        return value[1..].to_string();
    }
    value.to_string()
}

fn is_request_absolute(path: &str) -> bool {
    is_windows_drive(path) || path.starts_with('/') || path.starts_with("\\\\")
}

fn is_windows_drive(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

fn file_url_path(value: &str) -> Option<String> {
    let scheme = value.get(..5)?;
    if !scheme.eq_ignore_ascii_case("file:") {
        return None;
    }
    let decoded = percent_decode_lossy(&value[5..]);
    let mut rest = decoded.trim_start_matches(['/', '\\']);
    if let Some(tail) = strip_local_host(rest) {
        rest = tail;
    }
    if is_windows_drive(rest) {
        return Some(rest.replace('\\', "/"));
    }
    let local_root = decoded.starts_with("///")
        || decoded
            .trim_start_matches(['/', '\\'])
            .get(..10)
            .is_some_and(|head| head.eq_ignore_ascii_case("localhost/"));
    if local_root && !rest.is_empty() {
        return Some(format!("/{rest}"));
    }
    None
}

fn strip_local_host(rest: &str) -> Option<&str> {
    let head = rest.get(..10)?;
    if head.eq_ignore_ascii_case("localhost/") || head.eq_ignore_ascii_case("localhost\\") {
        return Some(&rest[10..]);
    }
    None
}

fn percent_decode_lossy(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (from_hex(bytes[index + 1]), from_hex(bytes[index + 2]))
            {
                out.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn shown(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

    #[test]
    fn codex_angle_href_and_drive_slash_stay_on_the_drive() {
        let root = Path::new("D:/work/demo");
        let expected = "C:/Users/admin/Documents/AI Workbench/2026-10-19/h5-3/snake.html";
        let angled = candidate_path(
            root,
            "</C:/Users/admin/Documents/AI Workbench/2026-10-19/h5-3/snake.html>",
        )
        .unwrap();
        assert_eq!(shown(&angled), expected);
        let slashed = candidate_path(
            root,
            "/C:/Users/admin/Documents/AI Workbench/2026-10-19/h5-3/snake.html",
        )
        .unwrap();
        assert_eq!(shown(&slashed), expected);
        let encoded = candidate_path(
            root,
            "file:///C:/Users/admin/Documents/AI%20Workbench/2026-10-19/h5-3/snake.html",
        )
        .unwrap();
        assert_eq!(shown(&encoded), expected);
        let localhost = candidate_path(
            root,
            "file://localhost/C:/Users/admin/Documents/AI Workbench/2026-10-19/h5-3/snake.html",
        )
        .unwrap();
        assert_eq!(shown(&localhost), expected);
    }

    #[test]
    fn relative_paths_still_join_the_project() {
        let root = Path::new("D:/work/demo");
        assert_eq!(
            shown(&candidate_path(root, "index.html").unwrap()),
            "D:/work/demo/index.html"
        );
        assert_eq!(
            shown(&candidate_path(root, "../secret.txt").unwrap()),
            "D:/work/secret.txt"
        );
        assert_eq!(
            shown(&candidate_path(root, "file:///tmp/notes.md").unwrap()),
            "/tmp/notes.md"
        );
        assert!(candidate_path(root, "   ").is_err());
    }

    #[test]
    fn line_column_range_and_hash_are_not_part_of_the_file() {
        let root = Path::new("D:/work/demo");
        let file = "D:/work/demo/src/Auth/LoginService.cs";
        for sample in [
            "src/Auth/LoginService.cs:648",
            "src/Auth/LoginService.cs:648:12",
            "src/Auth/LoginService.cs:648-660",
            "src/Auth/LoginService.cs:648:1-660:4",
            "src/Auth/LoginService.cs#L648",
            "src/Auth/LoginService.cs#L648-L660",
            "src/Auth/LoginService.cs:648?plain=1",
        ] {
            assert_eq!(shown(&candidate_path(root, sample).unwrap()), file, "{sample}");
        }
        assert_eq!(
            shown(&candidate_path(root, "C:/work/Auth/LoginService.cs:648").unwrap()),
            "C:/work/Auth/LoginService.cs"
        );
        assert_eq!(
            shown(&candidate_path(root, "C:/work/demo/index.html").unwrap()),
            "C:/work/demo/index.html"
        );
        assert_eq!(
            shown(&candidate_path(root, "src/Auth/LoginService.cs").unwrap()),
            file
        );
    }
}
