//! 回合输入（正文、技能附件、图片、页面标注）和斜杠命令表。

use serde_json::{json, Value};

use crate::models::{PageAnnotation, SlashCommand};

use super::super::state::KnownSkill;
use super::skills::{attachable_skill_path, is_skill_token};

pub(in crate::features::agents::codex) fn build_turn_input(
    text: &str,
    skills: &[KnownSkill],
    images: &[String],
    annotations: &[PageAnnotation],
) -> Value {
    let bytes = text.as_bytes();
    let mut elements = Vec::new();
    let mut attached: Vec<&KnownSkill> = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'$' {
            let start = index;
            let mut end = index + 1;
            while end < bytes.len() && is_skill_token(bytes[end]) {
                end += 1;
            }
            let token = &text[index + 1..end];
            if !token.is_empty() {
                if let Some(skill) = skills.iter().find(|skill| {
                    skill.mention.eq_ignore_ascii_case(token)
                        || skill.name.eq_ignore_ascii_case(token)
                }) {
                    elements.push(json!({
                        "byteRange": { "start": start, "end": end },
                        "placeholder": skill.label,
                    }));
                    if attachable_skill_path(&skill.path)
                        && !attached.iter().any(|item| item.path == skill.path)
                    {
                        attached.push(skill);
                    }
                }
            }
            index = end;
            continue;
        }
        index += 1;
    }
    let mut input = Vec::new();
    if !text.is_empty() || (images.is_empty() && annotations.is_empty()) {
        let mut text_item = json!({ "type": "text", "text": text });
        if !elements.is_empty() {
            text_item["text_elements"] = Value::Array(elements);
        }
        input.push(text_item);
    }
    for skill in attached {
        input.push(json!({
            "type": "skill",
            "name": skill.name,
            "path": skill.path,
        }));
    }
    for image in images {
        input.push(image_input_item(image));
    }
    for note in annotations {
        push_comment_attachment(&mut input, note, images);
    }
    Value::Array(input)
}

/// Codex 注释附件：评论文本单独成一条，截图走 localImage，不折进通用中文模板。
fn push_comment_attachment(input: &mut Vec<Value>, note: &PageAnnotation, images: &[String]) {
    let comment = comment_attachment_text(note);
    if !comment.is_empty() {
        input.push(json!({ "type": "text", "text": comment }));
    }
    if let Some(path) = note
        .screenshot
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        if !images.iter().any(|image| image == path) {
            input.push(image_input_item(path));
        }
    }
}

fn comment_attachment_text(note: &PageAnnotation) -> String {
    let comment = note.comment.trim();
    if !comment.is_empty() {
        return comment.to_string();
    }
    let selector = note.selector.trim();
    let url = note.url.trim();
    match (selector.is_empty(), url.is_empty()) {
        (false, false) => format!("{selector} {url}"),
        (false, true) => selector.to_string(),
        (true, false) => url.to_string(),
        (true, true) => String::new(),
    }
}

fn image_input_item(raw: &str) -> Value {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("data:") || lower.starts_with("https://") || lower.starts_with("http://") {
        json!({ "type": "image", "url": trimmed })
    } else {
        json!({ "type": "localImage", "path": trimmed })
    }
}

pub(in crate::features::agents::codex) fn split_command(text: &str) -> (String, String) {
    let body = text.trim().trim_start_matches('/');
    let mut parts = body.splitn(2, char::is_whitespace);
    let name = parts.next().unwrap_or("").to_ascii_lowercase();
    let rest = parts.next().unwrap_or("").trim().to_string();
    (name, rest)
}

/// 斜杠命令表。说明逐字取自 Codex TUI `slash_command.rs::description`；`/help` 是工作台自己的。
pub(in crate::features::agents::codex) fn slash_commands() -> Vec<SlashCommand> {
    vec![
        SlashCommand {
            name: "/permissions".into(),
            hint: "choose what Codex is allowed to do".into(),
            takes_args: true,
        },
        SlashCommand {
            name: "/status".into(),
            hint: "show current session configuration and token usage".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/diff".into(),
            hint: "show git diff (including untracked files)".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/review".into(),
            hint: "review my current changes and find issues".into(),
            takes_args: true,
        },
        SlashCommand {
            name: "/plan".into(),
            hint: "switch to Plan mode".into(),
            takes_args: true,
        },
        SlashCommand {
            name: "/model".into(),
            hint: "choose what model and reasoning effort to use".into(),
            takes_args: true,
        },
        SlashCommand {
            name: "/compact".into(),
            hint: "summarize conversation to prevent hitting the context limit".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/approve".into(),
            hint: "approve one retry of a recent auto-review denial".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/init".into(),
            hint: "create an AGENTS.md file with instructions for Codex".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/new".into(),
            hint: "start a new chat during a conversation".into(),
            takes_args: true,
        },
        SlashCommand {
            name: "/clear".into(),
            hint: "clear the terminal and start a new chat".into(),
            takes_args: true,
        },
        SlashCommand {
            name: "/stop".into(),
            hint: "stop all background terminals".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/quit".into(),
            hint: "exit Codex".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/mcp".into(),
            hint: "list MCP tools; use /mcp verbose or /mcp login <name>".into(),
            takes_args: true,
        },
        SlashCommand {
            name: "/goal".into(),
            hint: "set or view the goal for a long-running task".into(),
            takes_args: true,
        },
        SlashCommand {
            name: "/hooks".into(),
            hint: "view and manage lifecycle hooks".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/worktree".into(),
            hint: "在新的工作树里新建会话".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/help".into(),
            hint: "列出工作台能执行的斜杠命令".into(),
            takes_args: false,
        },
    ]
}
