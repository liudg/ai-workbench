//! 用户消息里的图片，写成 Claude 的 base64 图片块。读图在 [`crate::image_input`]。

use serde_json::{json, Value};

use crate::image_input;
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
    let (media_type, data) = image_input::load(source)?;
    Ok(json!({
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": data,
        }
    }))
}
