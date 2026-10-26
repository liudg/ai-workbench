//! 图片预览。核对扩展名和文件头，不把文本文件当成图片。

use std::path::Path;

use serde::Serialize;

use crate::{file_name, resolve_preview_file};
use aiwb_core::models::strip_verbatim_prefix;

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PreviewImage {
    pub path: String,
    pub name: String,
    pub mime: String,
    pub data_base64: String,
}

pub fn read_image_at(project_root: &Path, requested: &str) -> Result<PreviewImage, String> {
    let full = resolve_preview_file(project_root, requested)?;
    let ext = full
        .extension()
        .and_then(|item| item.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let meta = std::fs::metadata(&full).map_err(|err| format!("无法读取图片: {err}"))?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err("图片超过 20MB".into());
    }
    let bytes = std::fs::read(&full).map_err(|err| format!("无法读取图片: {err}"))?;
    let mime = crate::image_codec::classify_preview_image(&ext, &bytes)?;
    Ok(PreviewImage {
        path: strip_verbatim_prefix(&full.to_string_lossy()),
        name: file_name(&full),
        mime: mime.to_string(),
        data_base64: crate::image_codec::encode_base64(&bytes),
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::read_image_at;

    #[test]
    fn reads_png_and_svg_bytes_and_rejects_text() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00,
            0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08,
            0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE,
            0x02, 0xFE, 0xDC, 0xCC, 0x59, 0xE7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
            0xAE, 0x42, 0x60, 0x82,
        ];
        fs::write(root.join("available-live.png"), png).unwrap();
        fs::write(root.join("mark.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>
").unwrap();
        fs::write(root.join("notes.txt"), "not an image").unwrap();
        let image = read_image_at(root, "available-live.png").unwrap();
        assert_eq!(image.mime, "image/png");
        assert_eq!(image.name, "available-live.png");
        assert!(!image.data_base64.is_empty());
        let svg = read_image_at(root, "mark.svg").unwrap();
        assert_eq!(svg.mime, "image/svg+xml");
        let rejected = read_image_at(root, "notes.txt").unwrap_err();
        assert!(
            rejected.contains("不能以图片预览") || rejected.contains("不一致"),
            "{rejected}"
        );
    }
}
