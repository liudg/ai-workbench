//! `session/request_permission`：选项来自 Agent，回包 `{outcome: {outcome: "selected", optionId}}`，
//! 中断时回 `cancelled`。

use serde_json::{json, Value};

use super::updates::{strip_ticks, tool_name};
use crate::AgentError;
use aiwb_core::models::{PromptAnswer, PromptKind, PromptOption, SessionEventBody};

pub fn prompt_id(rpc_id: &Value) -> String {
    match rpc_id {
        Value::String(text) => format!("acp-{text}"),
        other => format!("acp-{other}"),
    }
}

/// 允许一次的选项 id。「完全访问」时宿主替用户选它。
pub fn allow_once(params: &Value) -> Option<String> {
    let options = params.get("options").and_then(Value::as_array)?;
    ["allow_once", "allow_always"].iter().find_map(|kind| {
        options
            .iter()
            .find(|option| option.get("kind").and_then(Value::as_str) == Some(*kind))
            .and_then(|option| option.get("optionId").and_then(Value::as_str))
            .map(str::to_string)
    })
}

pub fn permission_prompt(prompt_id: &str, params: &Value) -> (SessionEventBody, Vec<(String, String)>) {
    let tool = params.get("toolCall").unwrap_or(&Value::Null);
    let kind = tool.get("kind").and_then(Value::as_str).unwrap_or("");
    let title = strip_ticks(tool.get("title").and_then(Value::as_str).unwrap_or(""));
    let reason = tool
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("content"))
                .filter_map(|content| content.get("text").and_then(Value::as_str))
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let raw = params
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut kept = Vec::new();
    let options = raw
        .iter()
        .filter_map(|option| {
            let id = option.get("optionId").and_then(Value::as_str)?.to_string();
            let name = option.get("name").and_then(Value::as_str).unwrap_or(&id).to_string();
            let option_kind = option.get("kind").and_then(Value::as_str).unwrap_or("");
            kept.push((id.clone(), option_kind.to_string()));
            let (label, slot, tooltip) = match option_kind {
                "allow_once" => ("允许一次".to_string(), "primary", ""),
                "allow_always" => ("总是允许".to_string(), "scoped", "以后同类操作不再询问"),
                "reject_once" => ("拒绝".to_string(), "deny", ""),
                "reject_always" => ("总是拒绝".to_string(), "deny", "以后同类操作直接拒绝"),
                _ => (name, "", ""),
            };
            Some(PromptOption {
                id,
                label,
                slot: slot.into(),
                tooltip: tooltip.into(),
                ..Default::default()
            })
        })
        .collect();
    let (question, body, body_kind) = match kind {
        "execute" => ("允许运行这条命令？".to_string(), title.clone(), "command"),
        "edit" | "delete" | "move" => ("允许修改文件？".to_string(), title.clone(), "files"),
        _ if title.is_empty() => ("允许这次操作？".to_string(), String::new(), ""),
        _ => (format!("允许 {title}？"), String::new(), ""),
    };
    let event = SessionEventBody::Prompt {
        prompt_id: prompt_id.to_string(),
        prompt_kind: PromptKind::Approval,
        question,
        options,
        questions: Vec::new(),
        header: tool_name(kind, &title),
        subtitle: String::new(),
        body,
        body_kind: body_kind.into(),
        reason,
    };
    (event, kept)
}

pub fn cancelled() -> Value {
    json!({ "outcome": { "outcome": "cancelled" } })
}

/// 把界面对审批的回答写成回包，同时给出时间线上显示的答案。
pub fn respond(options: &[(String, String)], answer: &PromptAnswer) -> Result<(Value, String), AgentError> {
    let PromptAnswer::Single { value } = answer else {
        return Err(AgentError::Runtime("审批只接受一个选项".into()));
    };
    let value = value.trim();
    let picked = options
        .iter()
        .find(|(id, _)| id == value)
        .or_else(|| {
            let kind = if is_allow(value) { "allow_once" } else { "reject_once" };
            options.iter().find(|(_, option_kind)| option_kind == kind)
        })
        .ok_or_else(|| AgentError::Runtime(format!("没有这个选项：{value}")))?;
    let label = match picked.1.as_str() {
        "allow_once" => "允许一次",
        "allow_always" => "总是允许",
        "reject_always" => "总是拒绝",
        _ => "拒绝",
    };
    Ok((
        json!({ "outcome": { "outcome": "selected", "optionId": picked.0 } }),
        label.to_string(),
    ))
}

pub fn is_allow(value: &str) -> bool {
    matches!(
        value.trim(),
        "approve" | "accept" | "allow" | "yes" | "允许" | "实施"
    )
}

/// 一次审批的回答方式。
pub struct PermissionPending {
    pub options: Vec<(String, String)>,
}

impl super::PendingAnswer for PermissionPending {
    fn respond(&self, answer: &PromptAnswer) -> Result<(Value, String), AgentError> {
        respond(&self.options, answer)
    }
}
