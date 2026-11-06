//! 会话复制只读已保存的数据，不启动 Agent，也不恢复或切换工作树。

use aiwb_core::models::{PromptKind, SessionEventBody};
use aiwb_core::task::StoredEvent;

use super::tasks::TaskId;
use super::{blocking, ServiceResult, Services};

impl Services {
    pub(crate) fn task_workdir(&self, params: TaskId) -> ServiceResult<String> {
        self.runtimes.workdir_of_task(&params.id)
    }

    pub(crate) async fn export_task_markdown(&self, params: TaskId) -> ServiceResult<String> {
        let store = self.store.clone();
        blocking(move || {
            let task = store
                .task(&params.id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "任务不存在".to_string())?;
            let title = task.title.split_whitespace().collect::<Vec<_>>().join(" ");
            let title = if title.is_empty() {
                "新会话"
            } else {
                &title
            };
            let mut markdown = format!("# {}\n", escape_text(title));
            // task_sessions 按建立顺序读取主会话段，排除侧边聊天。
            for session in store.task_sessions(&task.id).map_err(|e| e.to_string())? {
                let events = store
                    .events_since(&session.id, 0)
                    .map_err(|e| e.to_string())?;
                append_segment(&mut markdown, session.agent.display_name(), &events);
            }
            Ok(markdown)
        })
        .await?
    }
}

fn append_segment(markdown: &mut String, agent: &str, events: &[StoredEvent]) {
    for (index, stored) in events.iter().enumerate() {
        match &stored.event.body {
            SessionEventBody::UserMessage {
                text,
                images,
                sender,
                ..
            } => {
                let mut body = text.clone();
                append_attachments(&mut body, images);
                append_message(
                    markdown,
                    if sender.is_some() {
                        "工作台消息"
                    } else {
                        "用户"
                    },
                    &body,
                );
            }
            SessionEventBody::AgentMessage {
                text,
                mode,
                dedupe_of,
                ..
            } => {
                if dedupe_of.as_ref().is_some_and(|id| !id.is_empty()) {
                    continue;
                }
                if mode.as_deref() == Some("plan") && duplicate_plan(events, index, text) {
                    continue;
                }
                append_message(markdown, agent, text);
            }
            SessionEventBody::ToolCall { name, images, .. }
                if name == "image_generation" && !images.is_empty() =>
            {
                let mut body = String::new();
                append_attachments(&mut body, images);
                append_message(markdown, &format!("{agent} · 图片"), &body);
            }
            SessionEventBody::PlanText { text, .. } => {
                append_message(markdown, &format!("{agent} · 计划"), text);
            }
            SessionEventBody::ReviewFindings {
                summary,
                findings,
                raw,
            } => {
                let mut body = summary.clone();
                for finding in findings {
                    body.push_str(&format!("\n\n### {}\n", escape_text(&finding.title)));
                    if !finding.location.is_empty() {
                        body.push_str(&format!("\n{}\n", escape_text(&finding.location)));
                    }
                    body.push('\n');
                    body.push_str(&finding.body);
                }
                append_message(
                    markdown,
                    &format!("{agent} · 审查"),
                    if body.trim().is_empty() { raw } else { &body },
                );
            }
            SessionEventBody::Prompt {
                prompt_kind,
                question,
                questions,
                options,
                ..
            } if *prompt_kind != PromptKind::Approval => {
                let mut body = question.clone();
                for option in options {
                    body.push_str(&format!("\n- {}", escape_text(&option.label)));
                }
                for item in questions {
                    body.push_str(&format!("\n\n{}", item.question));
                    if !item.description.is_empty() {
                        body.push_str(&format!("\n\n{}", item.description));
                    }
                    for option in &item.options {
                        body.push_str(&format!("\n- {}", escape_text(&option.label)));
                    }
                }
                append_message(markdown, &format!("{agent} · 提问"), &body);
            }
            SessionEventBody::PromptResolved { prompt_id, answer } => {
                let conversational = events.iter().any(|item| {
                    matches!(
                        &item.event.body,
                        SessionEventBody::Prompt { prompt_id: id, prompt_kind, .. }
                            if id == prompt_id && *prompt_kind != PromptKind::Approval
                    )
                });
                if conversational {
                    append_message(markdown, "用户 · 回答", answer);
                }
            }
            SessionEventBody::Error { message } => append_message(markdown, "错误", message),
            _ => {}
        }
    }
}

/// 与时间线一致：计划模式的答复若在本轮另有相同的计划卡，只输出计划卡。
fn duplicate_plan(events: &[StoredEvent], index: usize, text: &str) -> bool {
    let same_plan = |item: &StoredEvent| {
        matches!(
            &item.event.body, SessionEventBody::PlanText { text: plan, .. } if plan.trim() == text.trim()
        )
    };
    let same_turn =
        |item: &&StoredEvent| !matches!(item.event.body, SessionEventBody::UserMessage { .. });
    events[..index]
        .iter()
        .rev()
        .take_while(same_turn)
        .any(same_plan)
        || events[index + 1..]
            .iter()
            .take_while(same_turn)
            .any(same_plan)
}

fn append_attachments(body: &mut String, images: &[String]) {
    for image in images {
        let path = if image.starts_with("data:") {
            "内嵌图片"
        } else {
            image
        };
        if !body.is_empty() {
            body.push_str("\n\n");
        }
        body.push_str(&format!("附件：{}", escape_text(path)));
    }
}

fn append_message(markdown: &mut String, label: &str, body: &str) {
    if body.trim().is_empty() {
        return;
    }
    markdown.push_str(&format!("\n## {}\n\n", escape_text(label)));
    // 保留原始 Markdown 和代码缩进，不截断消息或把代码块套进另一层代码块。
    markdown.push_str(body.trim_end());
    markdown.push('\n');
}

fn escape_text(text: &str) -> String {
    let mut escaped = String::new();
    for ch in text.chars() {
        if "\\`*_{}[]<>#!|".contains(ch) {
            escaped.push('\\');
        }
        escaped.push(if ch == '\n' || ch == '\r' { ' ' } else { ch });
    }
    escaped
}
