//! 聊天图片：只把校验过的本机图片放进 asset 协议范围，再交给 WebView 显示。

use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Manager};

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// 确认路径是一张本机图片，并把它加入 asset 协议白名单。
/// 返回值可直接交给前端 `convertFileSrc`。
#[tauri::command]
pub fn prepare_chat_image(app: AppHandle, path: String) -> Result<String, String> {
    let canonical = validate_chat_image(&path)?;
    app.asset_protocol_scope()
        .allow_file(&canonical)
        .map_err(|err| format!("无法授权读取图片: {err}"))?;
    Ok(display_path(&canonical))
}

pub fn validate_chat_image(raw: &str) -> Result<PathBuf, String> {
    let path = local_path_from_input(raw)?;
    let ext = image_extension(&path).ok_or("只接受 png、jpg、gif、webp、bmp、ico、avif 图片")?;
    if path.components().any(|component| matches!(component, Component::ParentDir)) {
        return Err("路径不能包含 ..".into());
    }

    let canonical = std::fs::canonicalize(&path).map_err(|_| "图片不存在或无法读取".to_string())?;
    let meta = std::fs::metadata(&canonical).map_err(|_| "图片不存在或无法读取".to_string())?;
    if !meta.is_file() {
        return Err("路径不是文件".into());
    }
    if meta.len() == 0 {
        return Err("图片文件是空的".into());
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err("图片超过 20MB".into());
    }

    let mut file = File::open(&canonical).map_err(|_| "图片不存在或无法读取".to_string())?;
    let mut header = [0_u8; 32];
    let read = file
        .read(&mut header)
        .map_err(|_| "无法读取图片内容".to_string())?;
    if !sniff_image(&ext, &header[..read]) {
        return Err("文件内容和图片扩展名不一致".into());
    }
    Ok(canonical)
}

fn local_path_from_input(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim().trim_matches(|ch| ch == '"' || ch == '\'');
    if trimmed.is_empty() {
        return Err("图片路径为空".into());
    }
    if trimmed.to_ascii_lowercase().starts_with("https:")
        || trimmed.to_ascii_lowercase().starts_with("http:")
    {
        return Err("远程图片不走本机读取".into());
    }

    let text = if trimmed.to_ascii_lowercase().starts_with("file:") {
        file_url_to_path(trimmed)?
    } else {
        trimmed.to_string()
    };
    let path = PathBuf::from(text);
    if !path.is_absolute() {
        return Err("只接受本机绝对路径".into());
    }
    Ok(path)
}

fn file_url_to_path(raw: &str) -> Result<String, String> {
    let rest = raw.get(5..).ok_or("无效的 file 地址")?;
    let rest = rest.trim_start_matches(':');
    let rest = rest.strip_prefix("//").unwrap_or(rest);
    let decoded = percent_decode(rest.trim_start_matches('/'))?;
    const LOCALHOST: &str = "localhost/";
    if decoded.len() >= LOCALHOST.len()
        && decoded.as_bytes()[..LOCALHOST.len()].eq_ignore_ascii_case(LOCALHOST.as_bytes())
    {
        let path = &decoded[LOCALHOST.len()..];
        if is_drive_path(path) {
            return Ok(path.to_string());
        }
    }
    if is_drive_path(&decoded) {
        return Ok(decoded);
    }
    if decoded.is_empty() {
        return Err("无效的 file 地址".into());
    }
    Ok(format!(r"\\{}", decoded.replace('/', "\\")))
}

fn is_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("路径编码无效".into());
            }
            let high = hex_value(bytes[index + 1])?;
            let low = hex_value(bytes[index + 2])?;
            out.push((high << 4) | low);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "路径编码无效".to_string())
}

fn hex_value(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err("路径编码无效".into()),
    }
}

fn image_extension(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "avif"
    ) {
        Some(ext)
    } else {
        None
    }
}

fn sniff_image(ext: &str, header: &[u8]) -> bool {
    match ext {
        "png" => header.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
        "jpg" | "jpeg" => header.starts_with(&[0xFF, 0xD8, 0xFF]),
        "gif" => header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a"),
        "webp" => header.len() >= 12 && header.starts_with(b"RIFF") && &header[8..12] == b"WEBP",
        "bmp" => header.starts_with(b"BM"),
        "ico" => header.len() >= 4 && header[..4] == [0, 0, 1, 0],
        "avif" => is_isobmff_brand(header, &["avif", "avis"]),
        _ => false,
    }
}

fn is_isobmff_brand(header: &[u8], brands: &[&str]) -> bool {
    if header.len() < 12 || &header[4..8] != b"ftyp" {
        return false;
    }
    let brand = &header[8..12];
    brands.iter().any(|item| brand == item.as_bytes())
}

fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    text.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINI_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8,
        0xCF, 0xC0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE, 0x02, 0xFE, 0xDC, 0xCC,
        0x59, 0xE7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-workbench-chat-images-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn accepts_forward_slash_windows_png() {
        let dir = temp_dir("ok");
        let file = dir.join("header-opened-preview.png");
        std::fs::write(&file, MINI_PNG).unwrap();
        let forward = file.to_string_lossy().replace('\\', "/");
        let canonical = validate_chat_image(&forward).unwrap();
        let shown = display_path(&canonical);
        assert!(shown.to_ascii_lowercase().ends_with("header-opened-preview.png"));
        assert!(!shown.starts_with(r"\\?\"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn accepts_file_url() {
        let dir = temp_dir("file-url");
        let file = dir.join("shot.png");
        std::fs::write(&file, MINI_PNG).unwrap();
        let url = format!("file:///{}", file.to_string_lossy().replace('\\', "/"));
        assert!(validate_chat_image(&url).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_non_images_and_traversal() {
        let dir = temp_dir("reject");
        let text = dir.join("notes.txt");
        std::fs::write(&text, MINI_PNG).unwrap();
        assert!(validate_chat_image(&text.to_string_lossy()).is_err());

        let fake = dir.join("fake.png");
        std::fs::write(&fake, b"not a png").unwrap();
        assert!(validate_chat_image(&fake.to_string_lossy()).is_err());

        assert!(validate_chat_image(r"F:\temp\..\Windows\system.png").is_err());
        assert!(validate_chat_image(r"relative\shot.png").is_err());
        assert!(validate_chat_image("https://cdn.example.com/a.png").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
