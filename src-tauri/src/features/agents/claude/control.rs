//! stdin/stdout 上的控制协议。
//!
//! 宿主发出的请求对齐 Python SDK `query.py` `_send_control_request`（约 L706–747）：
//! `type=control_request`、`request_id` 为 `req_{counter}_{8 hex}`、一行一个 JSON。
//! 成功/失败回包对齐同文件 L679–704：`control_response.response.subtype` 为
//! `success` 或 `error`，用 `request_id` 配对。
//!
//! `can_use_tool` 的允许/拒绝对齐 `query.py` L617–634，以及 CLI
//! `utils/permissions/PermissionPromptToolResultSchema.ts`：
//! allow 带 `behavior=allow` 和 `updatedInput`；deny 带 `behavior=deny` 和 `message`。
//! 空的 `updatedInput` 会被 CLI 当成「用原始输入」（同文件约 L107–111），所以允许时写回原输入。
//!
//! 用户消息对齐 `client.py` `query`（约 L288–296）和 CLI `cli/structuredIO.ts`
//! `prependUserMessage`（约 L204–211）。

use serde_json::{json, Value};

use crate::features::agents::AgentError;
use crate::models::{PromptAnswer, PromptOption, PromptQuestion, QuestionSurface};

pub fn request_id(counter: u64) -> String {
    let hex = uuid::Uuid::new_v4().simple().to_string();
    format!("req_{counter}_{}", &hex[..8])
}

pub fn control_request(request_id: &str, request: Value) -> Value {
    json!({
        "type": "control_request",
        "request_id": request_id,
        "request": request,
    })
}

pub fn control_success(request_id: &str, response: Value) -> Value {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": response,
        }
    })
}

pub fn control_error(request_id: &str, error: &str) -> Value {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "error",
            "request_id": request_id,
            "error": error,
        }
    })
}

/// `query.py` `initialize`（约 L340–343）。没有 hook 时 `hooks` 为 null。
pub fn initialize_request() -> Value {
    json!({
        "subtype": "initialize",
        "hooks": null,
    })
}

pub fn user_message(session_id: &str, content: Value) -> Value {
    json!({
        "type": "user",
        "message": { "role": "user", "content": content },
        "parent_tool_use_id": null,
        "session_id": session_id,
    })
}

pub fn parse_control_response(value: &Value) -> Option<(String, Result<Value, String>)> {
    let response = value.get("response")?;
    let id = response.get("request_id")?.as_str()?.to_string();
    match response
        .get("subtype")
        .and_then(Value::as_str)
        .unwrap_or("")
    {
        "error" => {
            let message = response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Unknown error");
            Some((id, Err(message.to_string())))
        }
        _ => {
            let payload = response.get("response").cloned().unwrap_or(Value::Null);
            Some((id, Ok(payload)))
        }
    }
}

#[derive(Clone)]
pub enum PermissionKind {
    Approval {
        input: Value,
    },
    Questions {
        input: Value,
        questions: Vec<PromptQuestion>,
    },
    ExitPlan {
        input: Value,
    },
}

pub fn permission_result(
    kind: &PermissionKind,
    answer: &PromptAnswer,
) -> Result<Value, AgentError> {
    match kind {
        PermissionKind::Approval { input } | PermissionKind::ExitPlan { input } => {
            let PromptAnswer::Single { value } = answer else {
                return Err(AgentError::Runtime("审批只接受允许或拒绝".into()));
            };
            if is_allow(value) {
                Ok(json!({ "behavior": "allow", "updatedInput": input }))
            } else {
                let message = if matches!(kind, PermissionKind::ExitPlan { .. }) {
                    "用户拒绝了计划"
                } else {
                    "用户拒绝了这次操作"
                };
                Ok(json!({ "behavior": "deny", "message": message }))
            }
        }
        PermissionKind::Questions { input, questions } => match answer {
            PromptAnswer::Questions { skipped: true, .. } => Ok(json!({
                "behavior": "deny",
                "message": "用户跳过了提问",
            })),
            PromptAnswer::Questions {
                answers,
                skipped: false,
            } => {
                let mut updated = input.clone();
                let mut mapped = serde_json::Map::new();
                for question in questions {
                    let Some(text) = answers.get(&question.id).map(|item| item.trim()) else {
                        continue;
                    };
                    if text.is_empty() || question.question.trim().is_empty() {
                        continue;
                    }
                    mapped.insert(question.question.clone(), json!(text));
                }
                if mapped.is_empty() {
                    return Err(AgentError::Runtime("先回答至少一个问题".into()));
                }
                if let Value::Object(root) = &mut updated {
                    root.insert("answers".to_string(), Value::Object(mapped));
                }
                Ok(json!({ "behavior": "allow", "updatedInput": updated }))
            }
            _ => Err(AgentError::Runtime("提问需要逐题回答".into())),
        },
    }
}

pub fn is_allow(value: &str) -> bool {
    matches!(
        value.trim(),
        "approve" | "accept" | "allow" | "yes" | "允许"
    )
}

pub fn approval_options() -> Vec<PromptOption> {
    vec![
        PromptOption {
            id: "approve".into(),
            label: "允许".into(),
            description: String::new(),
            disabled_reason: None,
        },
        PromptOption {
            id: "reject".into(),
            label: "拒绝".into(),
            description: String::new(),
            disabled_reason: None,
        },
    ]
}

pub fn questions_from_input(input: &Value) -> Vec<PromptQuestion> {
    let Some(items) = input.get("questions").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let question = text_field(item, "question");
            let header = text_field(item, "header");
            let description = text_field(item, "description");
            let kind = text_field(item, "kind");
            // CLI 2.1.300：kind 为 text / number 时不带选项。choice 的 Other 由界面提供，不做成选项。
            let open_ended = kind == "text" || kind == "number";
            let options = if open_ended {
                Vec::new()
            } else {
                item.get("options")
                    .and_then(Value::as_array)
                    .map(|options| {
                        options
                            .iter()
                            .filter_map(|option| {
                                let label = text_field(option, "label");
                                if label.is_empty() {
                                    return None;
                                }
                                Some(PromptOption {
                                    id: label.clone(),
                                    label,
                                    description: text_field(option, "description"),
                                    disabled_reason: None,
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            };
            PromptQuestion {
                id: format!("q{}", index + 1),
                header,
                question,
                description,
                is_secret: false,
                is_other: !options.is_empty(),
                multi_select: !open_ended
                    && item
                        .get("multiSelect")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                surface: QuestionSurface::RequestInput,
                options,
                input_kind: if kind == "number" {
                    "number".into()
                } else {
                    String::new()
                },
                required: false,
            }
        })
        .filter(|question| !question.question.trim().is_empty())
        .collect()
}

fn text_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}
