//! 预览图片的类型核对和 base64。聊天附件的路径校验不在这里。

use std::path::Path;

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// 预览用的图片类型。扩展名和文件头对得上才返回 MIME。SVG 没有魔数，要求正文里有 `<svg`。
pub fn classify_preview_image(ext: &str, bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.is_empty() {
        return Err("图片文件是空的".into());
    }
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("图片超过 20MB".into());
    }
    let ext = ext.to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => return Err("这个文件不能以图片预览。".into()),
    };
    let matches = if ext == "svg" {
        looks_like_svg(bytes)
    } else {
        sniff_image(&ext, bytes)
    };
    if !matches {
        return Err("文件内容和图片扩展名不一致".into());
    }
    Ok(mime)
}

pub fn encode_base64(bytes: &[u8]) -> String {
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
        let b1 = if remain > 1 {
            bytes[index + 1] as u32
        } else {
            0
        };
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

fn looks_like_svg(bytes: &[u8]) -> bool {
    if bytes.contains(&0) {
        return false;
    }
    let text = String::from_utf8_lossy(bytes);
    let head: String = text.chars().take(4096).collect();
    head.to_ascii_lowercase().contains("<svg")
}

pub fn image_extension(path: &Path) -> Option<String> {
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

pub fn sniff_image(ext: &str, header: &[u8]) -> bool {
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
