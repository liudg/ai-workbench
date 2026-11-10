//! `elicitation/create`：模型调 `ask_question` 时发来的表单。
//!
//! 请求（2026-11-09 agy 1.5.3 实际收发）：
//! `{sessionId, toolCallId, mode: "form", message, requestedSchema: {properties: {
//!   q1: {type: "string", title, oneOf: [{const: "1", title}]},   单选
//!   q2: {type: "array", title, items: {anyOf: [{const, title}]}}, 多选
//!   q1_other: {type: "string", title: "Other", description}  }}}`  每题一个自由回答。
//! 回包 `{action: "accept", content: {q1: "1", q2: ["1","2"], q1_other: "…"}}`，
//! 跳过 `{action: "decline"}`，中断 `{action: "cancel"}`。

use serde_json::{json, Map, Value};

use crate::acp::PendingAnswer;
use crate::AgentError;
use aiwb_core::models::{PromptAnswer, PromptKind, PromptOption, PromptQuestion, QuestionSurface, SessionEventBody};

/// 模型在选项前面写的推荐标记。
const RECOMMENDED: &str = "(Recommended) ";

pub struct Field {
    id: String,
    multi: bool,
    options: Vec<(String, String)>,
    other: Option<String>,
}

pub struct ElicitationPending {
    fields: Vec<Field>,
}

pub fn question_prompt(prompt_id: &str, params: &Value) -> (SessionEventBody, ElicitationPending) {
    let properties = params
        .pointer("/requestedSchema/properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut names: Vec<&String> = properties.keys().filter(|name| !name.ends_with("_other")).collect();
    names.sort_by_key(|name| natural_key(name));
    let mut fields = Vec::new();
    let mut questions = Vec::new();
    for name in names {
        let schema = &properties[name];
        let multi = schema.get("type").and_then(Value::as_str) == Some("array");
        let items = if multi {
            schema.pointer("/items/anyOf").or_else(|| schema.pointer("/items/oneOf"))
        } else {
            schema.get("oneOf")
        };
        let mut options = Vec::new();
        let mut shown = Vec::new();
        for item in items.and_then(Value::as_array).into_iter().flatten() {
            let Some(id) = item.get("const").and_then(Value::as_str) else {
                continue;
            };
            let raw = item.get("title").and_then(Value::as_str).unwrap_or(id);
            let (label, description) = match raw.strip_prefix(RECOMMENDED) {
                Some(rest) => (rest.to_string(), "推荐".to_string()),
                None => (raw.to_string(), String::new()),
            };
            options.push((id.to_string(), label.clone()));
            shown.push(PromptOption {
                id: id.to_string(),
                label,
                description,
                ..Default::default()
            });
        }
        let other_key = format!("{name}_other");
        let other = properties.contains_key(&other_key).then_some(other_key);
        questions.push(PromptQuestion {
            id: name.clone(),
            header: String::new(),
            question: schema.get("title").and_then(Value::as_str).unwrap_or("").trim().to_string(),
            description: schema.get("description").and_then(Value::as_str).unwrap_or("").trim().to_string(),
            is_secret: false,
            is_other: other.is_some(),
            multi_select: multi,
            surface: QuestionSurface::RequestInput,
            options: shown,
            input_kind: String::new(),
            required: false,
        });
        fields.push(Field {
            id: name.clone(),
            multi,
            options,
            other,
        });
    }
    let event = SessionEventBody::Prompt {
        prompt_id: prompt_id.to_string(),
        prompt_kind: PromptKind::Questions,
        question: String::new(),
        options: Vec::new(),
        questions,
        header: String::new(),
        subtitle: String::new(),
        body: String::new(),
        body_kind: String::new(),
        reason: String::new(),
    };
    (event, ElicitationPending { fields })
}

/// `q2` 排在 `q10` 前面。
fn natural_key(name: &str) -> (usize, String) {
    let digits: String = name.chars().filter(char::is_ascii_digit).collect();
    (digits.parse().unwrap_or(usize::MAX), name.to_string())
}

pub fn cancelled() -> Value {
    json!({ "action": "cancel" })
}

impl PendingAnswer for ElicitationPending {
    fn respond(&self, answer: &PromptAnswer) -> Result<(Value, String), AgentError> {
        let PromptAnswer::Questions { answers, skipped } = answer else {
            return Err(AgentError::Runtime("提问需要逐题回答".into()));
        };
        if *skipped {
            return Ok((json!({ "action": "decline" }), "已跳过".into()));
        }
        let mut content = Map::new();
        let mut shown = Vec::new();
        for field in &self.fields {
            let Some(text) = answers.get(&field.id).map(|text| text.trim()).filter(|text| !text.is_empty()) else {
                continue;
            };
            shown.push(text.to_string());
            let by_label = |label: &str| {
                field
                    .options
                    .iter()
                    .find(|(id, option)| option == label || id == label)
                    .map(|(id, _)| id.clone())
            };
            if field.multi {
                let mut picked = Vec::new();
                let mut free = Vec::new();
                for part in text.split(", ").map(str::trim).filter(|part| !part.is_empty()) {
                    match by_label(part) {
                        Some(id) if !picked.contains(&id) => picked.push(id),
                        Some(_) => {}
                        None => free.push(part),
                    }
                }
                if !picked.is_empty() {
                    content.insert(field.id.clone(), json!(picked));
                }
                if let (Some(other), false) = (&field.other, free.is_empty()) {
                    content.insert(other.clone(), json!(free.join(", ")));
                }
            } else if let Some(id) = by_label(text) {
                content.insert(field.id.clone(), json!(id));
            } else if let Some(other) = &field.other {
                content.insert(other.clone(), json!(text));
            } else {
                return Err(AgentError::Runtime(format!("没有这个选项：{text}")));
            }
        }
        if content.is_empty() {
            return Err(AgentError::Runtime("先回答至少一个问题".into()));
        }
        Ok((json!({ "action": "accept", "content": content }), shown.join("；")))
    }

    fn cancelled(&self) -> Value {
        cancelled()
    }
}
