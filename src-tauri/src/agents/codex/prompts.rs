//! Codex 提问（审批 / requestUserInput / async questions）与回答载荷。

use serde_json::{json, Value};

use crate::agents::AgentError;
use crate::models::{
    PromptAnswer, PromptKind, PromptOption, PromptQuestion, SessionEventBody, SessionStatus,
};

use super::state::{emit, emit_status, Pending, Shared};

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
        let questions = parse_async_questions(item);
        if questions.is_empty() {
            return false;
        }
        self.question_items
            .lock()
            .unwrap()
            .insert(id.to_string());
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
        emit_status(&self.events, SessionStatus::NeedsInput);
        true
    }

    /// 把回答写回正在睡眠等待的回合。对齐终端里「在提问后直接输入回答」。
    pub(super) async fn steer_turn(&self, text: &str) -> Result<(), AgentError> {
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
                "input": [{ "type": "text", "text": text }],
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
        text.push_str("\n");
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
                        is_secret: q.get("isSecret").and_then(Value::as_bool).unwrap_or(false),
                        options,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// async 提问消息（agentMessage `questions` 字段）：
/// `[{ title, options: string[] | null }]`；协议没有题目 id，按序合成 q1/q2…
pub(super) fn parse_async_questions(item: &Value) -> Vec<PromptQuestion> {
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
                                .filter_map(Value::as_str)
                                .map(|label| PromptOption {
                                    id: label.to_string(),
                                    label: label.to_string(),
                                    description: String::new(),
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    Some(PromptQuestion {
                        id: format!("q{}", index + 1),
                        header: String::new(),
                        question: title,
                        is_secret: false,
                        options,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 阻塞式提问的 JSON-RPC 响应：跳过的题不出现在 answers 里（Codex 视为未答）。
pub(super) fn blocking_answer_payload(questions: &[PromptQuestion], answer: &PromptAnswer) -> Value {
    let mut map = serde_json::Map::new();
    match answer {
        PromptAnswer::Questions { answers, skipped } => {
            if !skipped {
                for q in questions {
                    if let Some(text) = answers.get(&q.id).map(|t| t.trim()).filter(|t| !t.is_empty())
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
    }
    json!({ "answers": map })
}

/// async 提问没有结构化回答通道：答案编成编号文本 steer 回回合（与终端输入一致）。
pub(super) fn async_answer_text(questions: &[PromptQuestion], answer: &PromptAnswer) -> String {
    match answer {
        PromptAnswer::Single { value } => value.clone(),
        PromptAnswer::Questions { answers, skipped } => {
            let lines = numbered_answer_lines(questions, answers, *skipped);
            if lines.is_empty() {
                skip_text()
            } else {
                lines.join("\n")
            }
        }
    }
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

pub(super) fn skip_text() -> String {
    "（用户跳过了这些问题，请按你的判断继续）".into()
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
    matches!(
        answer.trim(),
        "approve" | "accept" | "允许" | "yes" | "y"
    )
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
        assert!(questions[1].options.is_empty());
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
        let questions = parse_async_questions(&item);
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].id, "q1");
        assert_eq!(questions[0].options.len(), 3);
        assert_eq!(questions[1].id, "q2");
        assert!(questions[1].options.is_empty());
        // 普通消息没有 questions 字段
        assert!(parse_async_questions(&json!({ "type": "agentMessage", "id": "m", "text": "hi" })).is_empty());
    }

    #[test]
    fn blocking_payload_skips_unanswered() {
        let questions = parse_tool_questions(&question_fixture());
        let mut answers = std::collections::HashMap::new();
        answers.insert("framework".to_string(), " Vite ".to_string());
        answers.insert("constraints".to_string(), "   ".to_string());
        let payload = blocking_answer_payload(
            &questions,
            &PromptAnswer::Questions { answers, skipped: false },
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
    fn async_answer_numbers_lines_and_skips() {
        let questions = parse_tool_questions(&question_fixture());
        let mut answers = std::collections::HashMap::new();
        answers.insert("framework".to_string(), "Vite".to_string());
        let text = async_answer_text(
            &questions,
            &PromptAnswer::Questions { answers, skipped: false },
        );
        assert_eq!(text, "1. Vite");

        let skipped = async_answer_text(
            &questions,
            &PromptAnswer::Questions {
                answers: std::collections::HashMap::new(),
                skipped: true,
            },
        );
        assert!(skipped.contains("跳过"));

        let raw = async_answer_text(
            &questions,
            &PromptAnswer::Single { value: "随便".into() },
        );
        assert_eq!(raw, "随便");
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
            &PromptAnswer::Questions { answers, skipped: false },
        );
        assert_eq!(summary, "1. Vite\n2. 无");
    }
}
