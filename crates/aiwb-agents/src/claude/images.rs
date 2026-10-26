//! 用户消息里的图片。只接受本机文件和 `data:` URL。
//! 媒体类型只认扩展名：png / jpg / jpeg / gif / webp。不引入 base64 crate。

use serde_json::{json, Value};

use crate::AgentError;

pub fn message_content(text: &str, images: &[String]) -> Result<Value, AgentError> {
    if images.is_empty() {
        return Ok(Value::String(text.to_string()));
    }
    let mut blocks = Vec::new();
    if !text.is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    for image in images {
        blocks.push(image_block(image)?);
    }
    if blocks.is_empty() {
        return Err(AgentError::Runtime("消息不能为空".into()));
    }
    Ok(Value::Array(blocks))
}

pub fn image_block(source: &str) -> Result<Value, AgentError> {
    let (media_type, data) = image_data(source)?;
    Ok(json!({
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": data,
        }
    }))
}

fn image_data(source: &str) -> Result<(String, String), AgentError> {
    let source = source.trim();
    if source.starts_with("https://") || source.starts_with("http://") {
        return Err(AgentError::Runtime("只接受本机图片，不接受网络地址".into()));
    }
    if let Some(rest) = source.strip_prefix("data:") {
        return parse_data_url(rest);
    }
    let media_type = media_type_of(source)?;
    let bytes = std::fs::read(source).map_err(|err| {
        AgentError::Runtime(format!("找不到图片 {source}：{err}"))
    })?;
    if bytes.is_empty() {
        return Err(AgentError::Runtime(format!("图片是空的：{source}")));
    }
    Ok((media_type.to_string(), base64_encode(&bytes)))
}

fn parse_data_url(rest: &str) -> Result<(String, String), AgentError> {
    let (meta, data) = rest
        .split_once(',')
        .ok_or_else(|| AgentError::Runtime("data URL 缺少数据".into()))?;
    let mut parts = meta.split(';');
    let media = parts.next().unwrap_or("");
    let encoded = parts.any(|part| part.eq_ignore_ascii_case("base64"));
    if !encoded {
        return Err(AgentError::Runtime("data URL 需要 base64".into()));
    }
    let media_type = canonical_media(media).ok_or_else(|| {
        AgentError::Runtime(format!("不支持的图片类型：{media}"))
    })?;
    if data.is_empty() {
        return Err(AgentError::Runtime("data URL 没有图片数据".into()));
    }
    Ok((media_type.to_string(), data.to_string()))
}

fn media_type_of(path: &str) -> Result<&'static str, AgentError> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("");
    canonical_media(&format!("image/{ext}")).or_else(|| match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }).ok_or_else(|| AgentError::Runtime(format!("不支持的图片类型：{path}")))
}

fn canonical_media(media: &str) -> Option<&'static str> {
    match media.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("image/png"),
        "image/jpg" | "image/jpeg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

pub fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let mut index = 0;
    while index + 3 <= bytes.len() {
        let n = ((bytes[index] as u32) << 16)
            | ((bytes[index + 1] as u32) << 8)
            | (bytes[index + 2] as u32);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
        index += 3;
    }
    let rest = bytes.len() - index;
    if rest == 1 {
        let n = (bytes[index] as u32) << 16;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rest == 2 {
        let n = ((bytes[index] as u32) << 16) | ((bytes[index + 1] as u32) << 8);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}
