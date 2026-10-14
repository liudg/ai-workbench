//! 聊天图片：只把校验过的本机图片放进 asset 协议范围，再交给 WebView 显示。

use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use crate::models::strip_verbatim_prefix;

mod preview_codec;

#[cfg(test)]
mod tests;

pub use preview_codec::{classify_preview_image, encode_base64};

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

pub fn stage_image_bytes(
    dir: &Path,
    name: &str,
    bytes: &[u8],
) -> Result<(String, PathBuf), String> {
    if bytes.is_empty() {
        return Err("只能附加图片".into());
    }
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("图片超过 20MB".into());
    }
    let ext = sniff_kind(bytes).ok_or_else(|| "只能附加图片".to_string())?;
    let stem = safe_stem(name);
    let file_name = format!("{}-{stem}.{ext}", uuid::Uuid::new_v4().simple());
    let path = dir.join(&file_name);
    std::fs::write(&path, bytes).map_err(|err| format!("无法保存图片: {err}"))?;
    Ok((file_name, path))
}

fn sniff_kind(header: &[u8]) -> Option<&'static str> {
    if preview_codec::sniff_image("png", header) {
        Some("png")
    } else if preview_codec::sniff_image("jpg", header) {
        Some("jpg")
    } else if preview_codec::sniff_image("gif", header) {
        Some("gif")
    } else if preview_codec::sniff_image("webp", header) {
        Some("webp")
    } else if preview_codec::sniff_image("bmp", header) {
        Some("bmp")
    } else if preview_codec::sniff_image("ico", header) {
        Some("ico")
    } else if preview_codec::sniff_image("avif", header) {
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
    let ext = preview_codec::image_extension(&path)
        .ok_or("只接受 png、jpg、gif、webp、bmp、ico、avif 图片")?;
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
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
    if !preview_codec::sniff_image(&ext, &header[..read]) {
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
    let decoded = percent_decode(rest)?;
    if decoded.is_empty() {
        return Err("无效的 file 地址".into());
    }
    let (host, path) = if let Some(path) = decoded.strip_prefix('/') {
        ("", path)
    } else if let Some((host, path)) = decoded.split_once('/') {
        (host, path)
    } else {
        (decoded.as_str(), "")
    };
    let host_is_local = host.is_empty() || host.eq_ignore_ascii_case("localhost");
    if host_is_local {
        if is_drive_path(path) {
            return Ok(path.to_string());
        }
        if path.is_empty() {
            return Err("无效的 file 地址".into());
        }
        return Ok(format!("/{path}"));
    }
    if path.is_empty() {
        return Err("无效的 file 地址".into());
    }
    Ok(format!(r"\\{host}\{}", path.replace('/', "\\")))
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

fn display_path(path: &Path) -> String {
    strip_verbatim_prefix(&path.to_string_lossy())
}
