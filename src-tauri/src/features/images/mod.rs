//! 聊天图片：只把校验过的本机图片放进 asset 协议范围，再交给 WebView 显示。

use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use crate::models::strip_verbatim_prefix;

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// 确认路径是一张本机图片，并把它加入 asset 协议白名单。
/// 返回值可直接交给前端 `convertFileSrc`。
#[tauri::command]
pub fn prepare_chat_image<R: Runtime>(app: AppHandle<R>, path: String) -> Result<String, String> {
    let canonical = validate_chat_image(&path)?;
    app.asset_protocol_scope()
        .allow_file(&canonical)
        .map_err(|err| format!("无法授权读取图片: {err}"))?;
    Ok(display_path(&canonical))
}

/// 粘贴或拖入的图片先落到应用目录，避免剪贴板临时路径失效。
#[tauri::command]
pub fn stage_chat_image<R: Runtime>(
    app: AppHandle<R>,
    data_base64: String,
    name: String,
) -> Result<StagedImage, String> {
    let bytes = decode_base64(&data_base64)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("无法取得应用目录: {err}"))?
        .join("staged-images");
    std::fs::create_dir_all(&dir).map_err(|err| format!("无法创建图片缓存: {err}"))?;
    let (file_name, path) = stage_image_bytes(&dir, &name, &bytes)?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|err| format!("无法授权读取图片: {err}"))?;
    Ok(StagedImage {
        name: file_name,
        path: display_path(&path),
    })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StagedImage {
    pub name: String,
    pub path: String,
}

pub fn stage_image_bytes(dir: &Path, name: &str, bytes: &[u8]) -> Result<(String, PathBuf), String> {
    if bytes.is_empty() {
        return Err("只能附加图片".into());
    }
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("图片超过 20MB".into());
    }
    let ext = sniff_kind(bytes).ok_or_else(|| "只能附加图片".to_string())?;
    let stem = safe_stem(name);
    let file_name = format!(
        "{}-{stem}.{ext}",
        uuid::Uuid::new_v4().simple()
    );
    let path = dir.join(&file_name);
    std::fs::write(&path, bytes).map_err(|err| format!("无法保存图片: {err}"))?;
    Ok((file_name, path))
}

fn sniff_kind(header: &[u8]) -> Option<&'static str> {
    if sniff_image("png", header) {
        Some("png")
    } else if sniff_image("jpg", header) {
        Some("jpg")
    } else if sniff_image("gif", header) {
        Some("gif")
    } else if sniff_image("webp", header) {
        Some("webp")
    } else if sniff_image("bmp", header) {
        Some("bmp")
    } else if sniff_image("ico", header) {
        Some("ico")
    } else if sniff_image("avif", header) {
        Some("avif")
    } else {
        None
    }
}

fn safe_stem(name: &str) -> String {
    let base = Path::new(name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("image");
    let cleaned: String = base
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .take(40)
        .collect();
    if cleaned.is_empty() {
        "image".into()
    } else {
        cleaned
    }
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let trimmed = input.trim();
    let payload = trimmed
        .split_once(',')
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let mut filtered = Vec::with_capacity(payload.len());
    for byte in payload.bytes() {
        if !byte.is_ascii_whitespace() {
            filtered.push(byte);
        }
    }
    let mut padded = filtered;
    while padded.len() % 4 != 0 {
        padded.push(b'=');
    }
    let mut out = Vec::with_capacity(padded.len() / 4 * 3);
    let mut index = 0;
    while index < padded.len() {
        let chunk = &padded[index..index + 4];
        let values = [
            b64_value(chunk[0])?,
            b64_value(chunk[1])?,
            b64_value(chunk[2])?,
            b64_value(chunk[3])?,
        ];
        out.push((values[0] << 2) | (values[1] >> 4));
        if chunk[2] != b'=' {
            out.push((values[1] << 4) | (values[2] >> 2));
        }
        if chunk[3] != b'=' {
            out.push((values[2] << 6) | values[3]);
        }
        index += 4;
    }
    Ok(out)
}

fn b64_value(byte: u8) -> Result<u8, String> {
    match byte {
        b'A'..=b'Z' => Ok(byte - b'A'),
        b'a'..=b'z' => Ok(byte - b'a' + 26),
        b'0'..=b'9' => Ok(byte - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        b'=' => Ok(0),
        _ => Err("只能附加图片".into()),
    }
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
    strip_verbatim_prefix(&path.to_string_lossy())
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

    #[test]
    fn stages_pasted_png_bytes() {
        let dir = temp_dir("stage");
        let encoded = encode_base64(MINI_PNG);
        let bytes = decode_base64(&format!("data:image/png;base64,{encoded}")).unwrap();
        let (name, path) = stage_image_bytes(&dir, "clip board.png", &bytes).unwrap();
        assert!(name.ends_with(".png"));
        assert_eq!(std::fs::read(path).unwrap(), MINI_PNG);
        assert!(stage_image_bytes(&dir, "note.txt", b"hello").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn encode_base64(bytes: &[u8]) -> String {
        const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        let mut index = 0;
        while index + 3 <= bytes.len() {
            let n = ((bytes[index] as u32) << 16)
                | ((bytes[index + 1] as u32) << 8)
                | bytes[index + 2] as u32;
            out.push(TABLE[((n >> 18) & 63) as usize] as char);
            out.push(TABLE[((n >> 12) & 63) as usize] as char);
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
            out.push(TABLE[(n & 63) as usize] as char);
            index += 3;
        }
        if index < bytes.len() {
            let remain = bytes.len() - index;
            let b0 = bytes[index] as u32;
            let b1 = if remain > 1 { bytes[index + 1] as u32 } else { 0 };
            let n = (b0 << 16) | (b1 << 8);
            out.push(TABLE[((n >> 18) & 63) as usize] as char);
            out.push(TABLE[((n >> 12) & 63) as usize] as char);
            if remain > 1 {
                out.push(TABLE[((n >> 6) & 63) as usize] as char);
                out.push('=');
            } else {
                out.push('=');
                out.push('=');
            }
        }
        out
    }
}
