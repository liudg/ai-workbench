//! Codex 提问（审批 / requestUserInput / async questions）与回答载荷。

use serde_json::{json, Value};

use crate::features::agents::AgentError;
use crate::models::{
    PromptAnswer, PromptKind, PromptOption, PromptQuestion, QuestionSurface, SessionEventBody,
};

use super::state::{emit, Pending, Shared};

impl Shared {
    pub(super) fn maybe_emit_async_questions(&self, id: &str, item: &Value) -> bool {
        if id.is_empty() {
            return false;
        }
        {
            let handled = self.question_items.lock().unwrap();
            if handled.contains(id) {
                return true;
            }
        }
        let questions = parse_async_questions(item, id);
        if questions.is_empty() {
            return false;
        }
        self.question_items.lock().unwrap().insert(id.to_string());
        let prompt_id = format!("async-{id}");
        self.pending.lock().unwrap().insert(
            prompt_id.clone(),
            Pending::AsyncQuestions {
                questions: questions.clone(),
            },
        );
        let first = questions[0].question.clone();
        emit(
            &self.events,
            SessionEventBody::Prompt {
                prompt_id,
                prompt_kind: PromptKind::Questions,
                question: first,
                options: Vec::new(),
                questions,
            },
        );
        true
    }

    /// 回合结束时，官方 TUI 收起所有还没回答的 async 提问（`take_question_drafts`）。
    pub(super) fn drop_async_questions(&self) {
        let dropped: Vec<String> = {
            let mut pending = self.pending.lock().unwrap();
            let ids: Vec<String> = pending
                .iter()
                .filter(|(_, item)| matches!(item, Pending::AsyncQuestions { .. }))
                .map(|(id, _)| id.clone())
                .collect();
            for id in &ids {
                pending.remove(id);
            }
            ids
        };
        for id in dropped {
            self.resolve_prompt(&id, ASYNC_TURN_ENDED.into());
        }
    }

    /// 把回答作为普通用户输入写进正在进行的回合（运行中的回合里发消息即 steer）。
    pub(super) async fn steer_turn(&self, text: &str) -> Result<(), AgentError> {
        self.steer_input(json!([{ "type": "text", "text": text }]))
            .await
    }

    pub(super) async fn steer_input(&self, input: Value) -> Result<(), AgentError> {
        let thread_id = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Runtime("Codex 线程未建立".into()))?;
        let turn_id = self
            .turn_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Runtime("Codex 回合已结束".into()))?;
        self.request(
            "turn/steer",
            json!({
                "threadId": thread_id,
                "expectedTurnId": turn_id,
                "input": input,
            }),
        )
        .await?;
        Ok(())
    }

    pub(super) fn resolve_prompt(&self, prompt_id: &str, answer: String) {
        emit(
            &self.events,
            SessionEventBody::PromptResolved {
                prompt_id: prompt_id.to_string(),
                answer,
            },
        );
    }
}

pub(super) fn approval_question(method: &str, params: &Value) -> String {
    let reason = params.get("reason").and_then(Value::as_str).unwrap_or("");
    let command = params.get("command").and_then(Value::as_str).unwrap_or("");
    let title = match method {
        "item/fileChange/requestApproval" => "Codex 请求修改文件",
        "item/permissions/requestApproval" => "Codex 请求额外权限",
        _ => "Codex 请求执行命令",
    };
    let mut text = title.to_string();
    if !command.is_empty() {
        text.push('\n');
        text.push_str(command);
    }
    if command.is_empty() {
        if let Some(actions) = params.get("commandActions").and_then(Value::as_array) {
            let lines: Vec<&str> = actions
                .iter()
                .filter_map(|action| action.get("command").and_then(Value::as_str))
                .take(4)
                .collect();
            if !lines.is_empty() {
                text.push('\n');
                text.push_str(&lines.join("\n"));
            }
        }
    }
    if let Some(root) = params.get("grantRoot").and_then(Value::as_str) {
        if !root.is_empty() {
            text.push_str("\n写入根目录：");
            text.push_str(root);
        }
    }
    if !reason.is_empty() {
        text.push('\n');
        text.push_str(reason);
    }
    text
}

/// 阻塞式 `item/tool/requestUserInput` 的题目：
/// `{ id, header, question, isOther, isSecret, options: [{ label, description }] | null }`
pub(super) fn parse_tool_questions(params: &Value) -> Vec<PromptQuestion> {
    params
        .get("questions")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|q| {
                    let id = q.get("id").and_then(Value::as_str)?.to_string();
                    let question = q.get("question").and_then(Value::as_str)?.to_string();
                    let options = q
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|opts| {
                            opts.iter()
                                .filter_map(|opt| {
                                    let label = opt.get("label").and_then(Value::as_str)?;
                                    Some(PromptOption {
                                        id: label.to_string(),
                                        label: label.to_string(),
                                        description: opt
                                            .get("description")
                                            .and_then(Value::as_str)
                                            .unwrap_or("")
                                            .to_string(),
                                        ..Default::default()
                                    })
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    Some(PromptQuestion {
                        id,
                        header: q
                            .get("header")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        question,
                        description: String::new(),
                        is_secret: q.get("isSecret").and_then(Value::as_bool).unwrap_or(false),
                        // 桌面端 aai：`isOther: e.isOther===true`。映射里没有 isMultiSelect。
                        is_other: q.get("isOther").and_then(Value::as_bool).unwrap_or(false),
                        multi_select: false,
                        surface: QuestionSurface::RequestInput,
                        options,
                        input_kind: String::new(),
                        required: false,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 回合结束、提问被收起时卡片上的说明。
pub(super) const ASYNC_TURN_ENDED: &str = "回合已结束，未回答";

/// async 提问消息（agentMessage `questions` 字段）：`[{ title, options: string[] | null }]`。
/// 题目 id 与桌面端、TUI 相同：`JSON.stringify(["request_user_input_async", item id, 序号])`。
/// 选项最多 32 个，超过 512 字节的选项丢弃（`async_questions/state.rs::append`）。
pub(super) fn parse_async_questions(item: &Value, message_id: &str) -> Vec<PromptQuestion> {
    item.get("questions")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .enumerate()
                .filter_map(|(index, q)| {
                    let title = q.get("title").and_then(Value::as_str)?.trim().to_string();
                    if title.is_empty() {
                        return None;
                    }
                    let options = q
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|opts| {
                            opts.iter()
                                .take(32)
                                .filter_map(Value::as_str)
                                .filter(|label| label.len() <= 512)
                                .map(|label| PromptOption {
                                    id: label.to_string(),
                                    label: label.to_string(),
                                    description: String::new(),
                                    ..Default::default()
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    Some(PromptQuestion {
                        id: json!(["request_user_input_async", message_id, index]).to_string(),
                        header: String::new(),
                        question: title,
                        description: String::new(),
                        is_secret: false,
                        // 桌面端 sendUserMessageQuestion 的 S$e：`isOther: options.length > 0`。
                        is_other: !options.is_empty(),
                        multi_select: false,
                        surface: QuestionSurface::AsyncReply,
                        options,
                        input_kind: String::new(),
                        required: false,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 阻塞式提问的 JSON-RPC 响应：跳过的题不出现在 answers 里（Codex 视为未答）。
pub(super) fn blocking_answer_payload(
    questions: &[PromptQuestion],
    answer: &PromptAnswer,
) -> Value {
    let mut map = serde_json::Map::new();
    match answer {
        PromptAnswer::Questions { answers, skipped } => {
            if !skipped {
                for q in questions {
                    if let Some(text) = answers
                        .get(&q.id)
                        .map(|t| t.trim())
                        .filter(|t| !t.is_empty())
                    {
                        map.insert(q.id.clone(), json!({ "answers": [text] }));
                    }
                }
            }
        }
        PromptAnswer::Single { value } => {
            for q in questions {
                map.insert(q.id.clone(), json!({ "answers": [value] }));
            }
        }
        PromptAnswer::Elicitation { .. } => {}
    }
    json!({ "answers": map })
}

/// 每道已作答的 async 提问各成一条用户消息，正文是 `AnsweredQuestion::render`
/// （`codex-rs/context-fragments/src/answered_question.rs`）。
pub(super) fn async_replies(
    questions: &[PromptQuestion],
    answer: &PromptAnswer,
) -> Vec<(String, String)> {
    let PromptAnswer::Questions { answers, skipped } = answer else {
        return Vec::new();
    };
    if *skipped {
        return Vec::new();
    }
    questions
        .iter()
        .filter_map(|q| {
            let text = answers.get(&q.id)?.trim();
            (!text.is_empty()).then(|| (q.id.clone(), answered_question(&q.id, &q.question, text)))
        })
        .collect()
}

pub(super) fn answered_question(question_id: &str, question: &str, answer: &str) -> String {
    let mut end = question.len().min(512);
    while !question.is_char_boundary(end) {
        end -= 1;
    }
    let question = question[..end].replace(['\n', '\r'], " ");
    if question_id.len() > 512 {
        return format!("> {question}\n\n{answer}");
    }
    let replies = json!([{
        "answer": answer,
        "question": question,
        "questionItemId": question_id,
    }]);
    format!("<send_user_message_question_reply>\n{replies}\n</send_user_message_question_reply>")
}

/// 历史里的回答信封按 TUI `async_question_reply::display_text` 显示。
pub(super) fn async_reply_display(text: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Reply {
        #[allow(dead_code)]
        question_item_id: String,
        question: String,
        answer: String,
    }
    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum Replies {
        Many(Vec<Reply>),
        One(Reply),
    }
    let text = text.trim();
    let text = if text.starts_with("# Context from my IDE setup:\n") {
        text.rsplit_once("\n## My request for Codex:\n")?.1.trim()
    } else {
        text
    };
    let body = text
        .strip_prefix("<send_user_message_question_reply>")?
        .strip_suffix("</send_user_message_question_reply>")?;
    let replies = match serde_json::from_str::<Replies>(body).ok()? {
        Replies::Many(list) => list,
        Replies::One(reply) => vec![reply],
    };
    if replies.is_empty() {
        return None;
    }
    Some(
        replies
            .iter()
            .map(|reply| format!("> {}\n\n{}", reply.question, reply.answer))
            .collect::<Vec<_>>()
            .join("\n\n"),
    )
}

/// 卡片上的「已回答」摘要。
pub(super) fn questions_summary(questions: &[PromptQuestion], answer: &PromptAnswer) -> String {
    match answer {
        PromptAnswer::Single { value } => value.clone(),
        PromptAnswer::Questions { answers, skipped } => {
            let lines = numbered_answer_lines(questions, answers, *skipped);
            if lines.is_empty() {
                "已跳过".into()
            } else {
                lines.join("\n")
            }
        }
        PromptAnswer::Elicitation { action, .. } => elicitation_action_label(action),
    }
}

pub(super) fn numbered_answer_lines(
    questions: &[PromptQuestion],
    answers: &std::collections::HashMap<String, String>,
    skipped: bool,
) -> Vec<String> {
    if skipped {
        return Vec::new();
    }
    questions
        .iter()
        .enumerate()
        .filter_map(|(index, q)| {
            answers
                .get(&q.id)
                .map(|text| text.trim())
                .filter(|text| !text.is_empty())
                .map(|text| format!("{}. {}", index + 1, text))
        })
        .collect()
}

pub(super) fn error_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        other => {
            let text = other.to_string();
            if text == "null" || text == "{}" {
                None
            } else {
                Some(text)
            }
        }
    }
}

pub(super) fn rpc_error_text(err: &Value) -> String {
    err.get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("Codex 返回错误：{err}"))
}

pub(super) fn is_accept(answer: &str) -> bool {
    matches!(answer.trim(), "approve" | "accept" | "允许" | "yes" | "y")
}

pub(super) fn elicitation_action_label(action: &str) -> String {
    match action.trim() {
        "accept" | "接受" => "接受".into(),
        "decline" | "拒绝" => "拒绝".into(),
        "cancel" | "取消" => "取消".into(),
        other => other.to_string(),
    }
}

/// `elicitation/request` 与桌面端的 `mcpServer/elicitation/request` 用同一张卡片。
pub(super) fn parse_elicitation(params: &Value) -> (String, Vec<PromptQuestion>) {
    let message = params
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let server = params
        .get("serverName")
        .or_else(|| params.get("server"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let url = params
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let mut question = String::new();
    if !server.is_empty() {
        question.push_str(server);
    }
    if !message.is_empty() {
        if !question.is_empty() {
            question.push('\n');
        }
        question.push_str(message);
    }
    if !url.is_empty() {
        if !question.is_empty() {
            question.push('\n');
        }
        question.push_str(url);
    }
    if question.is_empty() {
        question = "需要补充信息".into();
    }
    let schema = params
        .get("requestedSchema")
        .or_else(|| params.get("schema"));
    (question, schema.map(schema_fields).unwrap_or_default())
}

fn schema_fields(schema: &Value) -> Vec<PromptQuestion> {
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<std::collections::HashSet<_>>()
        })
        .unwrap_or_default();
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return Vec::new();
    };
    properties
        .iter()
        .map(|(key, spec)| {
            let kind = spec.get("type").and_then(Value::as_str).unwrap_or("string");
            let title = spec.get("title").and_then(Value::as_str).unwrap_or("");
            let description = spec
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            let format = spec.get("format").and_then(Value::as_str).unwrap_or("");
            let options = spec
                .get("enum")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .map(|label| PromptOption {
                            id: label.to_string(),
                            label: label.to_string(),
                            description: String::new(),
                            ..Default::default()
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let question = if !description.is_empty() {
                description.to_string()
            } else if !title.is_empty() {
                title.to_string()
            } else {
                key.clone()
            };
            PromptQuestion {
                id: key.clone(),
                header: if title.is_empty() {
                    key.clone()
                } else {
                    title.to_string()
                },
                question,
                description: String::new(),
                is_secret: format == "password",
                is_other: false,
                multi_select: false,
                surface: QuestionSurface::RequestInput,
                options,
                input_kind: kind.to_string(),
                required: required.contains(key),
            }
        })
        .collect()
}

pub(super) fn elicitation_result(
    questions: &[PromptQuestion],
    answer: &PromptAnswer,
) -> Result<Value, crate::features::agents::AgentError> {
    use crate::features::agents::AgentError;
    let PromptAnswer::Elicitation { action, content } = answer else {
        return Err(AgentError::Runtime("请选择接受、拒绝或取消".into()));
    };
    let action = match action.trim() {
        "accept" | "接受" => "accept",
        "decline" | "拒绝" => "decline",
        "cancel" | "取消" => "cancel",
        _ => return Err(AgentError::Runtime("请选择接受、拒绝或取消".into())),
    };
    if action != "accept" {
        return Ok(json!({ "action": action }));
    }
    let mut map = serde_json::Map::new();
    for question in questions {
        match content.get(&question.id) {
            Some(value) => {
                map.insert(question.id.clone(), coerce_field(question, value));
            }
            None if question.required => {
                let label = if question.header.is_empty() {
                    question.id.as_str()
                } else {
                    question.header.as_str()
                };
                return Err(AgentError::Runtime(format!("请填写{label}")));
            }
            None => {}
        }
    }
    Ok(json!({ "action": "accept", "content": map }))
}

fn coerce_field(question: &PromptQuestion, value: &Value) -> Value {
    match question.input_kind.as_str() {
        "boolean" => match value {
            Value::Bool(flag) => json!(flag),
            Value::String(text) => json!(matches!(text.trim(), "true" | "1" | "yes" | "是")),
            other => other.clone(),
        },
        "number" | "integer" => match value {
            Value::Number(_) => value.clone(),
            Value::String(text) => {
                if question.input_kind == "integer" {
                    text.trim()
                        .parse::<i64>()
                        .map(|number| json!(number))
                        .unwrap_or_else(|_| json!(text))
                } else {
                    text.trim()
                        .parse::<f64>()
                        .map(|number| json!(number))
                        .unwrap_or_else(|_| json!(text))
                }
            }
            other => other.clone(),
        },
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question_fixture() -> Value {
        json!({
            "questions": [
                {
                    "id": "framework",
                    "header": "技术选型",
                    "question": "用哪个框架？",
                    "isOther": true,
                    "isSecret": false,
                    "options": [
                        { "label": "Vite", "description": "快速开发服务器" },
                        { "label": "Next.js", "description": "React 全栈" }
                    ]
                },
                {
                    "id": "constraints",
                    "header": "",
                    "question": "还有约束吗？",
                    "isOther": true,
                    "isSecret": true,
                    "options": null
                }
            ]
        })
    }

    #[test]
    fn parses_tool_questions() {
        let questions = parse_tool_questions(&question_fixture());
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].id, "framework");
        assert_eq!(questions[0].header, "技术选型");
        assert_eq!(questions[0].options.len(), 2);
        assert_eq!(questions[0].options[0].id, "Vite");
        assert_eq!(questions[0].options[0].description, "快速开发服务器");
        assert!(questions[0].is_other);
        assert!(!questions[0].multi_select);
        assert_eq!(questions[0].surface, QuestionSurface::RequestInput);
        assert!(questions[1].options.is_empty());
        assert!(questions[1].is_other);
        assert!(questions[1].is_secret);
    }

    #[test]
    fn parses_async_questions_with_synthesized_ids() {
        let item = json!({
            "type": "agentMessage",
            "id": "msg_1",
            "delivery": "async",
            "questions": [
                { "title": "用哪个框架？", "options": ["Vite", "Next.js", "Astro"] },
                { "title": "还有约束吗？", "options": null }
            ]
        });
        let questions = parse_async_questions(&item, "msg_1");
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].id, r#"["request_user_input_async","msg_1",0]"#);
        assert_eq!(questions[0].options.len(), 3);
        assert!(questions[0].is_other);
        assert_eq!(questions[0].surface, QuestionSurface::AsyncReply);
        assert_eq!(questions[1].id, r#"["request_user_input_async","msg_1",1]"#);
        assert!(questions[1].options.is_empty());
        assert!(!questions[1].is_other);
        // 普通消息没有 questions 字段
        assert!(parse_async_questions(
            &json!({ "type": "agentMessage", "id": "m", "text": "hi" }),
            "m"
        )
        .is_empty());
    }

    #[test]
    fn blocking_payload_skips_unanswered() {
        let questions = parse_tool_questions(&question_fixture());
        let mut answers = std::collections::HashMap::new();
        answers.insert("framework".to_string(), " Vite ".to_string());
        answers.insert("constraints".to_string(), "   ".to_string());
        let payload = blocking_answer_payload(
            &questions,
            &PromptAnswer::Questions {
                answers,
                skipped: false,
            },
        );
        assert_eq!(payload["answers"]["framework"]["answers"][0], json!("Vite"));
        assert!(payload["answers"].get("constraints").is_none());

        let skipped = blocking_answer_payload(
            &questions,
            &PromptAnswer::Questions {
                answers: std::collections::HashMap::new(),
                skipped: true,
            },
        );
        assert_eq!(skipped, json!({ "answers": {} }));
    }

    #[test]
    fn async_answers_use_the_official_reply_envelope() {
        let item = json!({
            "questions": [
                { "title": "Which framework?\nPick one", "options": ["Vite", "Astro"] },
                { "title": "Constraints?", "options": null }
            ]
        });
        let questions = parse_async_questions(&item, "msg_9");
        let mut answers = std::collections::HashMap::new();
        answers.insert(questions[0].id.clone(), " Vite ".to_string());
        answers.insert(questions[1].id.clone(), "  ".to_string());
        let replies = async_replies(
            &questions,
            &PromptAnswer::Questions {
                answers,
                skipped: false,
            },
        );
        assert_eq!(replies.len(), 1);
        assert_eq!(
            replies[0].1,
            "<send_user_message_question_reply>\n[{\"answer\":\"Vite\",\"question\":\"Which framework? Pick one\",\"questionItemId\":\"[\\\"request_user_input_async\\\",\\\"msg_9\\\",0]\"}]\n</send_user_message_question_reply>"
        );
        assert_eq!(
            async_reply_display(&replies[0].1).as_deref(),
            Some("> Which framework? Pick one\n\nVite")
        );
        assert!(async_replies(
            &questions,
            &PromptAnswer::Questions {
                answers: std::collections::HashMap::new(),
                skipped: true,
            },
        )
        .is_empty());
        let long_id = "x".repeat(513);
        assert_eq!(answered_question(&long_id, "Q", "A"), "> Q\n\nA");
    }

    #[test]
    fn async_options_are_bounded_like_the_tui() {
        let options: Vec<String> = (0..40).map(|i| format!("o{i}")).collect();
        let mut item = json!({ "questions": [{ "title": "t", "options": options }] });
        item["questions"][0]["options"][1] = json!("y".repeat(513));
        let parsed = parse_async_questions(&item, "m");
        assert_eq!(parsed[0].options.len(), 31);
    }

    #[test]
    fn summary_marks_skip() {
        let questions = parse_tool_questions(&question_fixture());
        let skipped = questions_summary(
            &questions,
            &PromptAnswer::Questions {
                answers: std::collections::HashMap::new(),
                skipped: true,
            },
        );
        assert_eq!(skipped, "已跳过");
        let mut answers = std::collections::HashMap::new();
        answers.insert("framework".to_string(), "Vite".to_string());
        answers.insert("constraints".to_string(), "无".to_string());
        let summary = questions_summary(
            &questions,
            &PromptAnswer::Questions {
                answers,
                skipped: false,
            },
        );
        assert_eq!(summary, "1. Vite\n2. 无");
    }

    #[test]
    fn elicitation_form_accepts_declines_and_cancels() {
        let (question, fields) = parse_elicitation(&json!({
            "serverName": "docs",
            "message": "需要仓库地址",
            "requestedSchema": {
                "type": "object",
                "required": ["url"],
                "properties": {
                    "url": { "type": "string", "title": "地址" },
                    "count": { "type": "integer", "title": "数量" },
                    "ok": { "type": "boolean", "title": "确认" }
                }
            }
        }));
        assert_eq!(question, "docs\n需要仓库地址");
        assert_eq!(fields.len(), 3);
        assert!(fields
            .iter()
            .any(|field| field.id == "url" && field.required));
        let mut content = serde_json::Map::new();
        content.insert("url".into(), json!("https://example.com"));
        content.insert("count".into(), json!("3"));
        content.insert("ok".into(), json!(true));
        let accepted = elicitation_result(
            &fields,
            &PromptAnswer::Elicitation {
                action: "接受".into(),
                content: content.into_iter().collect(),
            },
        )
        .unwrap();
        assert_eq!(accepted["action"], json!("accept"));
        assert_eq!(accepted["content"]["url"], json!("https://example.com"));
        assert_eq!(accepted["content"]["count"], json!(3));
        assert_eq!(accepted["content"]["ok"], json!(true));
        let declined = elicitation_result(
            &fields,
            &PromptAnswer::Elicitation {
                action: "decline".into(),
                content: std::collections::HashMap::new(),
            },
        )
        .unwrap();
        assert_eq!(declined, json!({ "action": "decline" }));
        let cancelled = elicitation_result(
            &fields,
            &PromptAnswer::Elicitation {
                action: "cancel".into(),
                content: std::collections::HashMap::new(),
            },
        )
        .unwrap();
        assert_eq!(cancelled, json!({ "action": "cancel" }));
    }
}
