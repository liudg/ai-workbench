//! Cursor 发给宿主的三种请求：工具审批、提问、计划。
//!
//! - `session/request_permission`：ACP 标准审批。选项来自 Cursor（允许一次 / 总是允许 / 拒绝），
//!   回包 `{outcome: {outcome: "selected", optionId}}`，中断时回 `cancelled`。
//! - `cursor/ask_question`：`{toolCallId, title, questions: [{id, prompt, options: [{id, label}], allowMultiple}]}`，
//!   回包 `answered` 带每题 `selectedOptionIds`，或 `skipped` / `cancelled`
//!   （`src/acp/interaction-handlers/ask-question-handler.ts`）。没有自由文本。
//! - `cursor/create_plan`：`{toolCallId, name, overview, plan, todos}`，回包 `accepted` / `rejected` / `cancelled`
//!   （`create-plan-handler.ts`）。
//!
//! 拒绝和跳过不带 `reason`：Cursor 自己补上原生的 `User rejected plan` / `User skipped questions`
//! 交给模型（cursor-agent 2026.10.22 `createPlan` / `askQuestion` 回包）。

use serde_json::{json, Value};

use crate::acp::permission;
use crate::AgentError;
use aiwb_core::models::{
    PromptAnswer, PromptKind, PromptOption, PromptQuestion, QuestionSurface, SessionEventBody,
};

#[derive(Clone)]
pub enum Pending {
    Questions { questions: Vec<Question> },
    Plan,
}

#[derive(Clone)]
pub struct Question {
    pub id: String,
    pub options: Vec<(String, String)>,
    pub multi: bool,
}

pub use permission::prompt_id;
use permission::is_allow;

/// 工作台自己 MCP 的工具调用。Cursor 的审批标题是「服务名: 工具名」（`3635.index.js` 的 `formatOperation`）。
pub fn workbench_tool(params: &Value) -> bool {
    let tool = params.get("toolCall").unwrap_or(&Value::Null);
    let title = tool.get("title").and_then(Value::as_str).unwrap_or("");
    tool.get("kind").and_then(Value::as_str) == Some("other")
        && title
            .strip_prefix(crate::WorkbenchMcp::SERVER_NAME)
            .and_then(|rest| rest.strip_prefix(": "))
            .is_some_and(|name| name.starts_with("aiwb_"))
}

pub fn question_prompt(prompt_id: &str, params: &Value) -> (SessionEventBody, Pending) {
    let title = params
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let items = params
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut pending = Vec::new();
    let mut questions = Vec::new();
    for item in &items {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let prompt = item.get("prompt").and_then(Value::as_str).unwrap_or("").trim();
        if prompt.is_empty() {
            continue;
        }
        let options: Vec<(String, String)> = item
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .filter_map(|option| {
                        let id = option.get("id").and_then(Value::as_str)?.to_string();
                        let label = option.get("label").and_then(Value::as_str).unwrap_or(&id).to_string();
                        Some((id, label))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let multi = item.get("allowMultiple").and_then(Value::as_bool).unwrap_or(false);
        questions.push(PromptQuestion {
            id: id.to_string(),
            header: String::new(),
            question: prompt.to_string(),
            description: String::new(),
            is_secret: false,
            is_other: false,
            multi_select: multi,
            surface: QuestionSurface::RequestInput,
            options: options
                .iter()
                .map(|(id, label)| PromptOption {
                    id: id.clone(),
                    label: label.clone(),
                    ..Default::default()
                })
                .collect(),
            input_kind: String::new(),
            required: false,
        });
        pending.push(Question {
            id: id.to_string(),
            options,
            multi,
        });
    }
    let event = SessionEventBody::Prompt {
        prompt_id: prompt_id.to_string(),
        prompt_kind: PromptKind::Questions,
        question: title,
        options: Vec::new(),
        questions,
        header: String::new(),
        subtitle: String::new(),
        body: String::new(),
        body_kind: String::new(),
        reason: String::new(),
    };
    (event, Pending::Questions { questions: pending })
}

pub fn plan_prompt(prompt_id: &str) -> (SessionEventBody, Pending) {
    let event = SessionEventBody::Prompt {
        prompt_id: prompt_id.to_string(),
        prompt_kind: PromptKind::Approval,
        question: "按这个计划实施？".into(),
        options: vec![
            PromptOption {
                id: "accept".into(),
                label: "实施".into(),
                slot: "primary".into(),
                ..Default::default()
            },
            PromptOption {
                id: "reject".into(),
                label: "不实施".into(),
                slot: "deny".into(),
                ..Default::default()
            },
        ],
        questions: Vec::new(),
        header: String::new(),
        subtitle: String::new(),
        body: String::new(),
        body_kind: String::new(),
        reason: String::new(),
    };
    (event, Pending::Plan)
}

/// 计划正文：有标题和概述时放在前面。
pub fn plan_text(params: &Value) -> String {
    let field = |key: &str| {
        params
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    // 实测 `plan` 是完整的 Markdown，自带标题；没有正文时才用标题和概述。
    if let Some(plan) = field("plan") {
        return plan.to_string();
    }
    let mut parts = Vec::new();
    if let Some(name) = field("name") {
        parts.push(format!("# {name}"));
    }
    if let Some(overview) = field("overview") {
        parts.push(overview.to_string());
    }
    parts.join("\n\n")
}

pub fn plan_accepted(result: &Value) -> bool {
    result.pointer("/outcome/outcome").and_then(Value::as_str) == Some("accepted")
}

/// 把界面的回答写成 Cursor 要的回包，同时给出时间线上显示的答案。
pub fn response(pending: &Pending, answer: &PromptAnswer) -> Result<(Value, String), AgentError> {
    match pending {
        Pending::Plan => {
            let PromptAnswer::Single { value } = answer else {
                return Err(AgentError::Runtime("计划只接受实施或不实施".into()));
            };
            if is_allow(value) {
                Ok((json!({ "outcome": { "outcome": "accepted" } }), "实施".into()))
            } else {
                Ok((
                    json!({ "outcome": { "outcome": "rejected" } }),
                    "不实施".into(),
                ))
            }
        }
        Pending::Questions { questions } => match answer {
            PromptAnswer::Questions { skipped: true, .. } => Ok((
                json!({ "outcome": { "outcome": "skipped" } }),
                "已跳过".into(),
            )),
            PromptAnswer::Questions { answers, .. } => {
                let mut picked = Vec::new();
                let mut shown = Vec::new();
                for question in questions {
                    let Some(text) = answers.get(&question.id).map(|text| text.trim()) else {
                        continue;
                    };
                    let ids = selected_ids(question, text);
                    if ids.is_empty() {
                        continue;
                    }
                    shown.push(text.to_string());
                    picked.push(json!({ "questionId": question.id, "selectedOptionIds": ids }));
                }
                if picked.is_empty() {
                    return Err(AgentError::Runtime("先回答至少一个问题".into()));
                }
                Ok((
                    json!({ "outcome": { "outcome": "answered", "answers": picked } }),
                    shown.join("；"),
                ))
            }
            _ => Err(AgentError::Runtime("提问需要逐题回答".into())),
        },
    }
}

/// 界面送回的是选项文字，多选用 `, ` 连起来。先整句对，再拆开对。
fn selected_ids(question: &Question, text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let by_label = |label: &str| {
        question
            .options
            .iter()
            .find(|(id, option)| option == label || id == label)
            .map(|(id, _)| id.clone())
    };
    if let Some(id) = by_label(text) {
        return vec![id];
    }
    if !question.multi {
        return Vec::new();
    }
    let mut ids = Vec::new();
    for part in text.split(", ") {
        if let Some(id) = by_label(part.trim()) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids
}
