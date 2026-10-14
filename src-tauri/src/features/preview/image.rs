//! 图片预览。核对扩展名和文件头，不把文本文件当成图片。

use std::path::Path;

use serde::Serialize;

use super::path::{file_name, resolve_preview_file};
use crate::models::strip_verbatim_prefix;

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
    let mime = crate::features::images::classify_preview_image(&ext, &bytes)?;
    Ok(PreviewImage {
        path: strip_verbatim_prefix(&full.to_string_lossy()),
        name: file_name(&full),
        mime: mime.to_string(),
        data_base64: crate::features::images::encode_base64(&bytes),
    })
}
