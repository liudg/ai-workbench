//! 把 Codex `thread/turns/list` 的条目映射成工作台事件。
//!
//! 实时会话（`rpc`）和目录恢复（`resume`）共用这一份映射。
//! 会话目录只负责列出线程，不在这里解析回合。

use std::collections::HashSet;

use serde_json::Value;

use aiwb_core::models::{MessagePhase, SessionEventBody, ToolStatus};

const HISTORY_PAGE: u32 = 20;
const TOOL_DETAIL_CAP: usize = 20_000;

pub const HISTORY_TURN_LIMIT: u32 = HISTORY_PAGE;

/// `thread/turns/list` 按更新时间倒序分页。翻回时间顺序后再渲染。
pub fn chronological_turns(pages_newest_first: &[Vec<Value>]) -> Vec<Value> {
    let mut turns = Vec::new();
    for page in pages_newest_first.iter().rev() {
        turns.extend(page.iter().rev().cloned());
    }
    turns
}

pub fn bodies_from_turns(turns: &[Value]) -> Vec<SessionEventBody> {
    let mut bodies = Vec::new();
    for turn in turns {
        let turn_id = turn
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let Some(items) = turn.get("items").and_then(Value::as_array) else {
            continue;
        };
        let plan = items
            .iter()
            .any(|item| item.get("type").and_then(Value::as_str) == Some("plan"));
        let mut anchored = false;
        let mut review: Option<(String, String)> = None;
        let mut files = Vec::new();
        for item in items {
            let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
            if kind == "userMessage" && !anchored && !turn_id.is_empty() {
                push_history_item(&mut bodies, &turn_id, plan, &mut files, item);
                bodies.push(SessionEventBody::TurnAnchor {
                    turn_id: turn_id.clone(),
                    mode: plan.then(|| "plan".to_string()),
                });
                anchored = true;
                continue;
            }
            if kind == "agentMessage" {
                let text = item
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if let Some((id, stored)) = review.clone() {
                    if stored == text && !text.is_empty() {
                        review = None;
                        bodies.push(SessionEventBody::AgentMessage {
                            text: take_chars(&text, 20_000),
                            stream_id: None,
                            phase: MessagePhase::parse(item.get("phase").and_then(Value::as_str)),
                            mode: plan.then(|| "plan".to_string()),
                            dedupe_of: Some(id),
                        });
                        continue;
                    }
                }
            }
            if kind == "exitedReviewMode" {
                let text = item.get("review").and_then(Value::as_str).unwrap_or("");
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    let id = item
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .unwrap_or("review")
                        .to_string();
                    review = Some((id, trimmed.to_string()));
                }
            }
            push_history_item(&mut bodies, &turn_id, plan, &mut files, item);
        }
        let turn_diff = turn.get("diff").and_then(Value::as_str).unwrap_or("");
        let mut summarized = false;
        if !turn_id.is_empty() && !turn_diff.is_empty() {
            let had_files = !files.is_empty();
            files = crate::changes::overlay_unified_diff(&files, turn_diff);
            if had_files {
                crate::changes::sync_file_change_counts(
                    &mut bodies,
                    &turn_id,
                    &files,
                );
            } else if !files.is_empty() {
                crate::changes::push_file_change_events(
                    &mut bodies,
                    &turn_id,
                    &files,
                );
                summarized = true;
            }
            bodies.push(SessionEventBody::TurnDiff {
                turn_id: turn_id.clone(),
                diff: turn_diff.to_string(),
            });
        }
        if !files.is_empty() && !summarized {
            crate::changes::sync_file_change_counts(
                &mut bodies,
                &turn_id,
                &files,
            );
            bodies.push(SessionEventBody::TurnChanges { turn_id, files });
        }
    }
    // 同一页里 Codex 会把已经写过的用户句和助手句再放进另一个 turn id。
    // 实时发送不经过这里，同文案的第二次亲手发送仍由会话日志追加。
    collapse_replayed_transcript(bodies)
}

/// 历史页里已经出现过的一轮，不要再追加同样的用户气泡和助手气泡。
///
/// 会话 `01a142da` 的 `thread/turns/list` 把「用提问工具问我2个问题」和同一段提问正文
/// 放进了两个 turn id。两次都是 `stream_id == None`，`load_history` 一次循环写完，序号递增。
/// 用户正文和至少一条助手正文都已经出现过时，这两条不再进入日志。
/// 这一轮里新的助手正文留下。助手带 `stream_id` 或 `dedupe_of` 的不参与比较。
fn collapse_replayed_transcript(bodies: Vec<SessionEventBody>) -> Vec<SessionEventBody> {
    let starts = user_message_indexes(&bodies);
    if starts.is_empty() {
        return bodies;
    }
    let mut drop = vec![false; bodies.len()];
    let mut seen_user: HashSet<(String, Vec<String>)> = HashSet::new();
    let mut seen_agent: HashSet<String> = HashSet::new();
    for (nth, start) in starts.iter().copied().enumerate() {
        let end = starts.get(nth + 1).copied().unwrap_or(bodies.len());
        let Some(user_key) = user_replay_key(&bodies[start]) else {
            continue;
        };
        if seen_user.contains(&user_key) {
            let repeated: Vec<usize> = bodies[start + 1..end]
                .iter()
                .enumerate()
                .filter_map(|(offset, body)| {
                    let text = replay_agent_text(body)?;
                    seen_agent.contains(&text).then_some(start + 1 + offset)
                })
                .collect();
            if !repeated.is_empty() {
                drop[start] = true;
                for index in repeated {
                    drop[index] = true;
                }
            }
        }
        seen_user.insert(user_key);
        for body in &bodies[start + 1..end] {
            if let Some(text) = replay_agent_text(body) {
                seen_agent.insert(text);
            }
        }
    }
    bodies
        .into_iter()
        .enumerate()
        .filter(|(index, _)| !drop[*index])
        .map(|(_, body)| body)
        .collect()
}

fn user_message_indexes(bodies: &[SessionEventBody]) -> Vec<usize> {
    bodies
        .iter()
        .enumerate()
        .filter_map(|(index, body)| match body {
            SessionEventBody::UserMessage { .. } => Some(index),
            _ => None,
        })
        .collect()
}

fn user_replay_key(body: &SessionEventBody) -> Option<(String, Vec<String>)> {
    match body {
        SessionEventBody::UserMessage { text, images, .. } => Some((text.clone(), images.clone())),
        _ => None,
    }
}

/// 历史回放写的助手正文没有流 id。带 `dedupe_of` 的审查重复另有标记，不在这里比较。
fn replay_agent_text(body: &SessionEventBody) -> Option<String> {
    match body {
        SessionEventBody::AgentMessage {
            text,
            stream_id: None,
            dedupe_of: None,
            ..
        } => Some(text.clone()),
        _ => None,
    }
}

fn push_history_item(
    bodies: &mut Vec<SessionEventBody>,
    turn_id: &str,
    plan: bool,
    files: &mut Vec<aiwb_core::models::FileChange>,
    item: &Value,
) {
    if item.get("type").and_then(Value::as_str) == Some("fileChange") {
        let parsed = crate::changes::file_changes_from_codex(
            item.get("changes").unwrap_or(&serde_json::Value::Null),
        );
        *files = crate::changes::merge_file_list(files, &parsed);
        for file in &parsed {
            let stored = files
                .iter()
                .find(|item| crate::changes::same_file(&item.path, &file.path))
                .unwrap_or(file);
            bodies.push(SessionEventBody::FileChange {
                turn_id: turn_id.to_string(),
                path: stored.path.clone(),
                status: stored.status,
                added: stored.added,
                removed: stored.removed,
                diff: stored.diff.clone(),
            });
        }
        return;
    }
    if let Some(view) = tool_view(item) {
        if tool_visible(&view) {
            bodies.push(tool_event(view, None));
        }
        return;
    }
    match item.get("type").and_then(Value::as_str).unwrap_or("") {
        "userMessage" => {
            let text = user_item_text(item);
            let text = super::prompts::async_reply_display(&text).unwrap_or(text);
            let images = user_item_images(item)
                .into_iter()
                .map(|image| take_chars(&image, 20_000))
                .collect::<Vec<_>>();
            if !text.is_empty() || !images.is_empty() {
                bodies.push(SessionEventBody::UserMessage {
                    text: take_chars(&text, 20_000),
                    images,
                    annotations: 0,
                    sender: None,
                });
            }
        }
        "agentMessage" => {
            let text = item.get("text").and_then(Value::as_str).unwrap_or("");
            if !text.is_empty() {
                bodies.push(SessionEventBody::AgentMessage {
                    text: take_chars(text, 20_000),
                    stream_id: None,
                    phase: MessagePhase::parse(item.get("phase").and_then(Value::as_str)),
                    mode: plan.then(|| "plan".to_string()),
                    dedupe_of: None,
                });
            }
        }
        "reasoning" => {
            let text = reasoning_text(item);
            if !text.trim().is_empty() {
                bodies.push(SessionEventBody::Thinking {
                    text: take_chars(&text, 20_000),
                    stream_id: None,
                });
            }
        }
        "plan" => {
            let text = item.get("text").and_then(Value::as_str).unwrap_or("");
            if !text.is_empty() {
                bodies.push(SessionEventBody::PlanText {
                    text: take_chars(text, 20_000),
                    stream_id: None,
                    mode: Some("plan".into()),
                });
            }
        }
        "enteredReviewMode" => {
            let text = item.get("review").and_then(Value::as_str).unwrap_or("");
            if !text.is_empty() {
                bodies.push(SessionEventBody::ReviewNote {
                    text: take_chars(text, 4_000),
                });
            }
        }
        "exitedReviewMode" => {
            let text = item.get("review").and_then(Value::as_str).unwrap_or("");
            if !text.trim().is_empty() {
                bodies.push(super::gap::parse_review_output(text));
            }
        }
        _ => {}
    }
}

#[derive(Default)]
pub(super) struct ToolView {
    pub(super) name: String,
    pub(super) summary: String,
    pub(super) detail: String,
    pub(super) images: Vec<String>,
    pub(super) status: ToolStatus,
    pub(super) exit_code: Option<i64>,
}

pub(super) fn tool_view(item: &Value) -> Option<ToolView> {
    let mut view = match item.get("type").and_then(Value::as_str).unwrap_or("") {
        "commandExecution" => command_view(item),
        "mcpToolCall" => mcp_view(item),
        "webSearch" => web_view(item),
        "imageGeneration" => super::images::generation_view(item),
        kind if image_item_kind(kind) => image_view(item),
        _ => return None,
    };
    view.exit_code = item.get("exitCode").and_then(Value::as_i64);
    view.status = item_status(item, view.exit_code);
    Some(view)
}

/// `status` 来自 app-server 的 `CommandExecutionStatus` / `McpToolCallStatus` 等：
/// `inProgress`、`completed`、`failed`、`declined`。没有这个字段的条目按已结束算。
fn item_status(item: &Value, exit_code: Option<i64>) -> ToolStatus {
    let status = item.get("status").and_then(Value::as_str).unwrap_or("");
    let failure = item
        .get("error")
        .or_else(|| item.get("failure"))
        .is_some_and(|value| !value.is_null());
    match status {
        "inProgress" => ToolStatus::Running,
        "failed" | "declined" => ToolStatus::Failed,
        _ if failure || exit_code.is_some_and(|code| code != 0) => ToolStatus::Failed,
        _ => ToolStatus::Completed,
    }
}

pub(super) fn tool_event(view: ToolView, stream_id: Option<String>) -> SessionEventBody {
    SessionEventBody::ToolCall {
        name: view.name,
        summary: view.summary,
        detail: take_chars(&view.detail, TOOL_DETAIL_CAP),
        stream_id,
        // 图片可能是完整 data URL，不能按文本摘要截断。
        images: view.images,
        status: view.status,
        exit_code: view.exit_code,
    }
}

pub(super) fn tool_visible(view: &ToolView) -> bool {
    !view.summary.trim().is_empty() || !view.detail.trim().is_empty() || !view.images.is_empty()
}

fn command_view(item: &Value) -> ToolView {
    ToolView {
        name: "command".into(),
        summary: command_summary(item),
        detail: command_output(item),
        images: Vec::new(),
        ..ToolView::default()
    }
}

/// 状态和退出码另有字段，摘要只放命令本身。
fn command_summary(item: &Value) -> String {
    item.get("command").and_then(Value::as_str).unwrap_or("").to_string()
}

fn command_output(item: &Value) -> String {
    let mut parts = Vec::new();
    for key in ["aggregatedOutput", "output", "stdout", "stderr"] {
        let Some(text) = item.get(key).and_then(Value::as_str) else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() || parts.iter().any(|existing: &String| existing == text) {
            continue;
        }
        parts.push(text.to_string());
    }
    parts.join("\n")
}

fn mcp_view(item: &Value) -> ToolView {
    let tool = item.get("tool").and_then(Value::as_str).unwrap_or("mcp");
    let server = item
        .get("server")
        .or_else(|| item.get("serverName"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut parts = Vec::new();
    if let Some(args) = item.get("arguments").or_else(|| item.get("input")) {
        if !args.is_null() {
            parts.push(format!("参数\n{}", pretty_value(args)));
        }
    }
    if let Some(result) = item.get("result").or_else(|| item.get("output")) {
        if !result.is_null() {
            parts.push(format!("结果\n{}", pretty_value(result)));
        }
    }
    if let Some(err) = item.get("error") {
        if !err.is_null() {
            parts.push(format!("错误\n{}", pretty_value(err)));
        }
    }
    ToolView {
        name: tool.to_string(),
        summary: format!("MCP {server} {tool}").trim().to_string(),
        detail: parts.join("\n\n"),
        images: Vec::new(),
        ..ToolView::default()
    }
}

fn web_view(item: &Value) -> ToolView {
    let query = item.get("query").and_then(Value::as_str).unwrap_or("");
    let mut parts = Vec::new();
    if let Some(action) = item.get("action") {
        if !action.is_null() {
            parts.push(pretty_value(action));
        }
    }
    if let Some(results) = item.get("results").or_else(|| item.get("output")) {
        if !results.is_null() {
            parts.push(pretty_value(results));
        }
    }
    ToolView {
        name: "web_search".into(),
        summary: query.to_string(),
        detail: parts.join("\n\n"),
        images: Vec::new(),
        ..ToolView::default()
    }
}

fn image_item_kind(kind: &str) -> bool {
    matches!(
        kind.replace('_', "").to_ascii_lowercase().as_str(),
        "image" | "imageview" | "localimage"
    )
}

fn image_view(item: &Value) -> ToolView {
    let mut images = user_item_images(item);
    if let Some(image) = image_from_part(item) {
        if !images.contains(&image) {
            images.push(image);
        }
    }
    for key in ["path", "url"] {
        if let Some(value) = item.get(key).and_then(Value::as_str) {
            if !value.is_empty() && !images.contains(&value.to_string()) {
                images.push(value.to_string());
            }
        }
    }
    let summary = images
        .first()
        .map(|image| {
            if image.starts_with("data:") {
                "图片".to_string()
            } else {
                image.clone()
            }
        })
        .unwrap_or_else(|| "图片".into());
    ToolView {
        name: "image".into(),
        summary,
        detail: String::new(),
        images,
        ..ToolView::default()
    }
}

fn pretty_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
    }
}

pub fn reasoning_text(item: &Value) -> String {
    let summary = joined_parts(item.get("summary"));
    if !summary.trim().is_empty() {
        return summary;
    }
    joined_parts(item.get("content"))
}

fn joined_parts(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(part_text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn part_text(part: &Value) -> Option<String> {
    match part {
        Value::String(text) => Some(text.clone()),
        Value::Object(_) => part.get("text").and_then(Value::as_str).map(str::to_string),
        _ => None,
    }
}

pub(super) fn user_item_text(item: &Value) -> String {
    match item.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                let kind = part.get("type").and_then(Value::as_str).unwrap_or("text");
                if kind == "text" || kind == "input_text" {
                    part.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub(super) fn user_item_images(item: &Value) -> Vec<String> {
    let parts = item
        .get("content")
        .or_else(|| item.get("input"))
        .and_then(Value::as_array);
    let Some(parts) = parts else {
        return Vec::new();
    };
    parts.iter().filter_map(image_from_part).collect()
}

pub(super) fn image_from_part(part: &Value) -> Option<String> {
    let kind = part
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .replace('_', "")
        .to_ascii_lowercase();
    if !matches!(kind.as_str(), "localimage" | "image" | "inputimage") {
        return None;
    }
    part.get("path")
        .and_then(Value::as_str)
        .or_else(|| part.get("url").and_then(Value::as_str))
        .or_else(|| part.get("image_url").and_then(Value::as_str))
        .or_else(|| part.pointer("/image_url/url").and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}


pub(super) fn take_chars(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(max).collect();
        out.push('…');
        out
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    #[test]
    fn history_turns_are_chronological_and_map_messages() {
        let older = vec![
            json!({"id": "t1", "items": [{"type": "userMessage", "content": [{"type": "text", "text": "你好"}]}]}),
        ];
        let newer = vec![json!({"id": "t2", "items": [{"type": "agentMessage", "text": "完成"}]})];
        let turns = chronological_turns(&[newer, older]);
        let bodies = bodies_from_turns(&turns);
        assert!(
            matches!(bodies[0], SessionEventBody::UserMessage { ref text, .. } if text == "你好")
        );
        assert!(
            matches!(bodies[1], SessionEventBody::TurnAnchor { ref turn_id, .. } if turn_id == "t1")
        );
        assert!(
            matches!(bodies[2], SessionEventBody::AgentMessage { ref text, phase: None, .. } if text == "完成")
        );
    }

    #[test]
    fn history_keeps_image_parts_on_the_user_message() {
        let turns = vec![json!({
            "items": [{
                "type": "userMessage",
                "content": [
                    { "type": "text", "text": "看这张" },
                    { "type": "localImage", "path": "C:/shot.png" },
                    { "type": "image", "url": "https://example.com/a.png" }
                ]
            }]
        })];
        let bodies = bodies_from_turns(&turns);
        match &bodies[0] {
            SessionEventBody::UserMessage { text, images, .. } => {
                assert_eq!(text, "看这张");
                assert_eq!(
                    images,
                    &vec![
                        "C:/shot.png".to_string(),
                        "https://example.com/a.png".to_string()
                    ]
                );
            }
            _ => panic!("expected user message"),
        }
    }

    #[test]
    fn history_maps_message_phase_for_every_adapter_consumer() {
        let turns = vec![json!({
            "items": [
                {"type": "userMessage", "content": [{"type": "text", "text": "看一下"}]},
                {"type": "agentMessage", "text": "我会查看目录。", "phase": "commentary"},
                {"type": "agentMessage", "text": "目录里有 src。", "phase": "final_answer"}
            ]
        })];
        let bodies = bodies_from_turns(&turns);
        assert!(matches!(
            &bodies[1],
            SessionEventBody::AgentMessage { text, phase, .. }
                if text == "我会查看目录。" && *phase == Some(MessagePhase::Commentary)
        ));
        assert!(matches!(
            &bodies[2],
            SessionEventBody::AgentMessage { text, phase, .. }
                if text == "目录里有 src。" && *phase == Some(MessagePhase::FinalAnswer)
        ));
        assert_eq!(
            MessagePhase::parse(Some("partial_answer")),
            Some(MessagePhase::PartialAnswer)
        );
        assert_eq!(MessagePhase::parse(Some("unknown")), None);
    }

    #[test]
    fn history_keeps_command_output_patches_mcp_and_search() {
        let output = format!("{}GAP-HISTORY-TAIL", "A".repeat(400));
        let turns = vec![json!({
            "items": [
                {
                    "type": "commandExecution",
                    "command": "echo marker",
                    "status": "completed",
                    "exitCode": 0,
                    "aggregatedOutput": output
                },
                {
                    "type": "fileChange",
                    "status": "completed",
                    "changes": [{
                        "path": "gap-history.txt",
                        "kind": "update",
                        "diff": "@@ -0,0 +1 @@\n+gap-history-marker"
                    }]
                },
                {
                    "type": "mcpToolCall",
                    "server": "docs",
                    "tool": "lookup",
                    "arguments": { "q": "codex" },
                    "result": "found"
                },
                {
                    "type": "webSearch",
                    "query": "codex desktop",
                    "results": [{ "title": "Codex" }]
                },
                {
                    "type": "imageView",
                    "path": "shot.png"
                }
            ]
        })];
        let bodies = bodies_from_turns(&turns);
        assert!(matches!(
            &bodies[0],
            SessionEventBody::ToolCall { name, detail, .. }
                if name == "command" && detail.contains("GAP-HISTORY-TAIL") && detail.len() > 240
        ));
        assert!(matches!(
            &bodies[1],
            SessionEventBody::FileChange { path, diff, .. }
                if path == "gap-history.txt" && diff.contains("gap-history-marker")
        ));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnChanges { files, .. } if files.iter().any(|file| file.path == "gap-history.txt")
        )));
        assert!(!bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::ToolCall { name, .. } if name == "apply_patch"
        )));
        assert!(matches!(
            &bodies[2],
            SessionEventBody::ToolCall { name, summary, detail, .. }
                if name == "lookup" && summary.contains("docs") && detail.contains("found")
        ));
        assert!(matches!(
            &bodies[3],
            SessionEventBody::ToolCall { name, summary, detail, .. }
                if name == "web_search" && summary == "codex desktop" && detail.contains("Codex")
        ));
        assert!(matches!(
            &bodies[4],
            SessionEventBody::ToolCall { name, images, .. }
                if name == "image" && images.as_slice() == ["shot.png"]
        ));
    }

    #[test]
    fn history_replays_file_changes_plan_mode_and_review_dedupe() {
        let review = "审查结论：通过";
        let turns = vec![json!({
            "id": "turn-plan",
            "diff": "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
            "items": [
                {"type": "userMessage", "content": [{"type": "text", "text": "做个计划"}]},
                {"type": "plan", "text": "先改 app.ts"},
                {"type": "agentMessage", "text": "计划写好了"},
                {"type": "exitedReviewMode", "id": "rev-1", "review": review},
                {"type": "agentMessage", "text": review},
                {
                    "type": "fileChange",
                    "changes": [{
                        "path": "src/app.ts",
                        "kind": "update",
                        "diff": "@@ -1 +1 @@\n-old\n+new"
                    }]
                }
            ]
        })];
        let bodies = bodies_from_turns(&turns);
        assert!(matches!(
            &bodies[1],
            SessionEventBody::TurnAnchor { turn_id, mode, .. }
                if turn_id == "turn-plan" && mode.as_deref() == Some("plan")
        ));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::PlanText { text, mode, .. }
                if text == "先改 app.ts" && mode.as_deref() == Some("plan")
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::AgentMessage { text, mode, dedupe_of, .. }
                if text == "计划写好了"
                    && mode.as_deref() == Some("plan")
                    && dedupe_of.is_none()
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::AgentMessage { text, dedupe_of, .. }
                if text == review && dedupe_of.as_deref() == Some("rev-1")
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::FileChange { turn_id, path, status, .. }
                if turn_id == "turn-plan"
                    && path == "src/app.ts"
                    && *status == aiwb_core::models::FileStatus::Modified
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnChanges { turn_id, files }
                if turn_id == "turn-plan" && files.iter().any(|file| file.path == "src/app.ts")
        )));
        assert!(!bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::ToolCall { name, .. } if name == "apply_patch"
        )));
    }

    #[test]
    fn history_replay_keeps_patch_counts_when_a_later_diff_is_empty() {
        let turns = vec![json!({
            "id": "turn-count",
            "items": [
                {"type": "userMessage", "content": [{"type": "text", "text": "改 notes"}]},
                {"type": "fileChange", "changes": [{
                    "path": "C:\\proj\\notes.md",
                    "kind": { "type": "update", "move_path": null },
                    "diff": "@@ -1 +1,2 @@\n-old\n+new-a\n+new-b\n"
                }]},
                {"type": "fileChange", "changes": [{
                    "path": "C:\\proj\\notes.md",
                    "kind": { "type": "update", "move_path": null },
                    "diff": ""
                }]}
            ]
        })];
        let bodies = bodies_from_turns(&turns);
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::FileChange { path, added, removed, .. }
                if path == "C:/proj/notes.md" && *added == 2 && *removed == 1
        )));
        assert!(bodies.iter().all(|body| !matches!(
            body,
            SessionEventBody::FileChange { added, removed, .. } if *added == 0 && *removed == 0
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnChanges { turn_id, files }
                if turn_id == "turn-count"
                    && files.len() == 1
                    && files[0].added == 2
                    && files[0].removed == 1
        )));
    }

    #[test]
    fn history_file_change_counts_unified_diff_and_diff() {
        let turns = vec![json!({
            "id": "turn-keys",
            "items": [{
                "type": "fileChange",
                "changes": [
                    {
                        "path": "from-diff.md",
                        "kind": "update",
                        "diff": "@@ -1 +1 @@\n-a\n+b\n"
                    },
                    {
                        "path": "from-unified.md",
                        "kind": "update",
                        "unified_diff": "@@ -1 +1,2 @@\n-old\n+u1\n+u2\n"
                    }
                ]
            }]
        })];
        let bodies = bodies_from_turns(&turns);
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::FileChange { path, added, removed, .. }
                if path == "from-diff.md" && *added == 1 && *removed == 1
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::FileChange { path, added, removed, .. }
                if path == "from-unified.md" && *added == 2 && *removed == 1
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnChanges { turn_id, files }
                if turn_id == "turn-keys"
                    && files.len() == 2
                    && files.iter().any(|file| file.path == "from-diff.md" && file.added == 1 && file.removed == 1)
                    && files.iter().any(|file| file.path == "from-unified.md" && file.added == 2 && file.removed == 1)
        )));
    }

    #[test]
    fn history_nonempty_diff_replaces_counts() {
        let turns = vec![json!({
            "id": "turn-replace",
            "items": [
                {"type": "fileChange", "changes": [{
                    "path": "notes.md",
                    "kind": { "type": "update", "move_path": null },
                    "diff": "@@ -1 +1,2 @@\n-old\n+new-a\n+new-b\n"
                }]},
                {"type": "fileChange", "changes": [{
                    "path": "notes.md",
                    "kind": { "type": "update", "move_path": null },
                    "unified_diff": "@@ -1 +1 @@\n-old\n+only\n"
                }]}
            ]
        })];
        let bodies = bodies_from_turns(&turns);
        let notes: Vec<_> = bodies
            .iter()
            .filter_map(|body| match body {
                SessionEventBody::FileChange {
                    path,
                    added,
                    removed,
                    diff,
                    ..
                } if path == "notes.md" => Some((*added, *removed, diff.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(notes.len(), 2);
        assert!(notes
            .iter()
            .all(|(added, removed, diff)| *added == 1 && *removed == 1 && diff.contains("+only")));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnChanges { turn_id, files }
                if turn_id == "turn-replace"
                    && files.len() == 1
                    && files[0].added == 1
                    && files[0].removed == 1
                    && files[0].diff.contains("+only")
                    && !files[0].diff.contains("+new-b")
        )));
    }

    #[test]
    fn history_turn_diff_is_the_turn_total() {
        let turns = vec![json!({
            "id": "turn-blank",
            "diff": "diff --git a/kept.md b/kept.md\n--- a/kept.md\n+++ b/kept.md\n@@ -1 +1 @@\n-a\n+from-turn\ndiff --git a/blank.md b/blank.md\n--- a/blank.md\n+++ b/blank.md\n@@ -0,0 +1,2 @@\n+one\n+two\n",
            "items": [
                {"type": "userMessage", "content": [{"type": "text", "text": "改 notes"}]},
                {"type": "fileChange", "changes": [{
                    "path": "kept.md",
                    "kind": { "type": "update", "move_path": null },
                    "diff": "@@ -1 +1,2 @@\n-old\n+new-a\n+new-b\n"
                }]},
                {"type": "fileChange", "changes": [{
                    "path": "C:/proj/blank.md",
                    "kind": { "type": "update", "move_path": null },
                    "diff": ""
                }]}
            ]
        })];
        let bodies = bodies_from_turns(&turns);
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::FileChange { path, added, removed, diff, .. }
                if path == "kept.md"
                    && *added == 1
                    && *removed == 1
                    && diff.contains("+from-turn")
                    && !diff.contains("+new-a")
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::FileChange { path, added, removed, diff, .. }
                if path == "C:/proj/blank.md"
                    && *added == 2
                    && *removed == 0
                    && diff.contains("+one")
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnChanges { turn_id, files }
                if turn_id == "turn-blank"
                    && files.len() == 2
                    && files.iter().any(|file| {
                        file.path == "kept.md"
                            && file.added == 1
                            && file.removed == 1
                            && file.diff.contains("+from-turn")
                    })
                    && files.iter().any(|file| {
                        file.path == "C:/proj/blank.md"
                            && file.added == 2
                            && file.removed == 0
                            && file.diff.contains("+two")
                    })
        )));
    }

    #[test]
    fn resume_replay_without_turn_diff_keeps_counts() {
        let newest = vec![json!({
            "id": "turn-new",
            "items": [
                {"type": "userMessage", "content": [{"type": "text", "text": "加一行"}]},
                {"type": "fileChange", "changes": [{
                    "path": "new.md",
                    "kind": "add",
                    "content": "new-line\n"
                }]}
            ]
        })];
        let older = vec![json!({
            "id": "turn-old",
            "items": [
                {"type": "userMessage", "content": [{"type": "text", "text": "改旧文件"}]},
                {"type": "fileChange", "changes": [{
                    "path": "old.md",
                    "kind": "update",
                    "diff": "@@ -1,2 +1 @@\n-a\n-b\n+c\n"
                }]}
            ]
        })];
        let turns = chronological_turns(&[newest, older]);
        assert!(turns.iter().all(|turn| turn.get("diff").is_none()));
        assert_eq!(
            turns
                .iter()
                .filter_map(|turn| turn.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            ["turn-old", "turn-new"]
        );
        let bodies = bodies_from_turns(&turns);
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnChanges { turn_id, files }
                if turn_id == "turn-old"
                    && files.len() == 1
                    && files[0].path == "old.md"
                    && files[0].added == 1
                    && files[0].removed == 2
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnChanges { turn_id, files }
                if turn_id == "turn-new"
                    && files.len() == 1
                    && files[0].path == "new.md"
                    && files[0].added == 1
                    && files[0].removed == 0
        )));
        assert!(bodies.iter().all(|body| !matches!(
            body,
            SessionEventBody::FileChange { added, removed, .. } if *added == 0 && *removed == 0
        )));
    }

    #[test]
    fn history_prefers_reasoning_summary_over_content() {
        let turns = vec![json!({
            "items": [{
                "type": "reasoning",
                "id": "r1",
                "summary": [{ "type": "summary_text", "text": "先看入口" }],
                "content": ["更长的原文"]
            }]
        })];
        let bodies = bodies_from_turns(&turns);
        assert!(matches!(
            bodies[0],
            SessionEventBody::Thinking { ref text, stream_id: None } if text == "先看入口"
        ));
    }

    /// 会话 `codex-cli:01a142da-511d-78a3-90a9-996e1dfeacc9`：
    /// 同一页两个 turn id，用户句和提问正文各出现两次，`stream_id` 都是空。
    #[test]
    fn history_replay_keeps_one_copy_of_a_repeated_question_turn() {
        let prompt = "用提问工具问我2个问题";
        let question = "你希望这次任务优先达成什么结果？\n- 完成指定目标\n- 先梳理可行方向\n\n你希望我用哪种方式呈现结果？\n- 简洁说明\n- 详细说明";
        let numbered = "1. 你希望这次任务优先达成什么结果？\n2. 你希望我用简洁说明还是详细说明呈现结果？";
        let done = "已通过提问工具提出两个问题。";
        let later_user = "向我请求权限批准";
        let later_agent = "请批准我继续执行当前任务。";
        let turns = vec![
            json!({
                "id": "01a142da-552b-7613-99ab-c05cd146797b",
                "items": [
                    {"type": "userMessage", "content": [{"type": "text", "text": prompt}]},
                    {"type": "agentMessage", "text": question, "phase": "final_answer"},
                    {"type": "agentMessage", "text": numbered, "phase": "final_answer"}
                ]
            }),
            json!({
                "id": "01a142da-be0f-7043-bdd8-063f4b4c0346",
                "items": [
                    {"type": "userMessage", "content": [{"type": "text", "text": prompt}]},
                    {"type": "agentMessage", "text": question, "phase": "final_answer"},
                    {"type": "agentMessage", "text": done, "phase": "final_answer"}
                ]
            }),
            json!({
                "id": "01a142db-ba20-75e3-bd85-8e830ac00623",
                "items": [
                    {"type": "userMessage", "content": [{"type": "text", "text": later_user}]},
                    {"type": "agentMessage", "text": later_agent, "phase": "final_answer"}
                ]
            }),
        ];
        let bodies = bodies_from_turns(&turns);
        assert_eq!(
            message_texts(&bodies, "user"),
            vec![prompt.to_string(), later_user.to_string()]
        );
        assert_eq!(
            message_texts(&bodies, "agent"),
            vec![
                question.to_string(),
                numbered.to_string(),
                done.to_string(),
                later_agent.to_string(),
            ]
        );
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnAnchor { turn_id, .. }
                if turn_id == "01a142da-be0f-7043-bdd8-063f4b4c0346"
        )));
    }

    #[test]
    fn history_replay_drops_an_exact_second_copy_of_the_same_turn() {
        let turns = vec![
            json!({
                "id": "t1",
                "items": [
                    {"type": "userMessage", "content": [{"type": "text", "text": "reply ok"}]},
                    {"type": "agentMessage", "text": "ok", "phase": "final_answer"}
                ]
            }),
            json!({
                "id": "t2",
                "items": [
                    {"type": "userMessage", "content": [{"type": "text", "text": "reply ok"}]},
                    {"type": "agentMessage", "text": "ok", "phase": "final_answer"}
                ]
            }),
        ];
        let bodies = bodies_from_turns(&turns);
        assert_eq!(message_texts(&bodies, "user"), vec!["reply ok".to_string()]);
        assert_eq!(message_texts(&bodies, "agent"), vec!["ok".to_string()]);
    }

    #[test]
    fn history_replay_keeps_a_second_send_when_the_reply_is_new() {
        let turns = vec![
            json!({
                "id": "t1",
                "items": [
                    {"type": "userMessage", "content": [{"type": "text", "text": "reply ok"}]},
                    {"type": "agentMessage", "text": "ok", "phase": "final_answer"}
                ]
            }),
            json!({
                "id": "t2",
                "items": [
                    {"type": "userMessage", "content": [{"type": "text", "text": "reply ok"}]},
                    {"type": "agentMessage", "text": "收到，换一种说法。", "phase": "final_answer"}
                ]
            }),
        ];
        let bodies = bodies_from_turns(&turns);
        assert_eq!(
            message_texts(&bodies, "user"),
            vec!["reply ok".to_string(), "reply ok".to_string()]
        );
        assert_eq!(
            message_texts(&bodies, "agent"),
            vec!["ok".to_string(), "收到，换一种说法。".to_string()]
        );
    }

    #[test]
    fn history_replay_does_not_treat_streamed_agent_text_as_a_replay() {
        let bodies = super::collapse_replayed_transcript(vec![
            SessionEventBody::UserMessage {
                text: "写数字".into(),
                images: Vec::new(),
                annotations: 0,
                sender: None,
            },
            SessionEventBody::AgentMessage {
                text: "1 2 3".into(),
                stream_id: Some("msg-a".into()),
                phase: Some(MessagePhase::FinalAnswer),
                mode: None,
                dedupe_of: None,
            },
            SessionEventBody::UserMessage {
                text: "写数字".into(),
                images: Vec::new(),
                annotations: 0,
                sender: None,
            },
            SessionEventBody::AgentMessage {
                text: "1 2 3".into(),
                stream_id: Some("msg-b".into()),
                phase: Some(MessagePhase::FinalAnswer),
                mode: None,
                dedupe_of: None,
            },
        ]);
        assert_eq!(
            message_texts(&bodies, "user"),
            vec!["写数字".to_string(), "写数字".to_string()]
        );
        assert_eq!(
            message_texts(&bodies, "agent"),
            vec!["1 2 3".to_string(), "1 2 3".to_string()]
        );
    }

    fn message_texts(bodies: &[SessionEventBody], kind: &str) -> Vec<String> {
        bodies
            .iter()
            .filter_map(|body| match (kind, body) {
                ("user", SessionEventBody::UserMessage { text, .. }) => Some(text.clone()),
                ("agent", SessionEventBody::AgentMessage { text, .. }) => Some(text.clone()),
                _ => None,
            })
            .collect()
    }


}
