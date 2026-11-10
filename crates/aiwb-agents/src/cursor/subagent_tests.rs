//! 子 Agent、后端报错和工作台 MCP。报文取自 2026-11-05 本机 Cursor Agent 2026.10.22-27dcf5f 的
//! `agent acp` 实际收发（`_meta.subagents` 打开，并行派两个子 Agent；工具调用 id 缩短）。

use std::path::Path;

use serde_json::{json, Value};

use super::prompts;
use super::subagents::Subagents;
use super::dialect::RULES;
use crate::acp::updates::UpdateMap;
use aiwb_core::models::{SessionEventBody, SessionStatus, SubagentCard, SubagentStatus, ToolStatus};

const PROJECT: &str = r"C:\ws";
const MAIN: &str = "1d726391";
const CHILD: &str = "aaead776";
const TOOL: &str = "call-c87a-0\nfc_4949_0";

fn cards(events: &[SessionEventBody]) -> Vec<&SubagentCard> {
    events
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::Subagent(card) => Some(card),
            _ => None,
        })
        .collect()
}

fn apply(subagents: &mut Subagents, session: &str, update: Value) -> Vec<SessionEventBody> {
    subagents.apply(session, &update).unwrap_or_else(|| panic!("没有认领：{update}"))
}

#[test]
fn task_call_spawn_child_steps_and_state_make_one_card() {
    let mut subagents = Subagents::new(Path::new(PROJECT));
    let events = apply(
        &mut subagents,
        MAIN,
        json!({
            "sessionUpdate": "tool_call", "toolCallId": TOOL, "title": "Task: Subagent A replies APPLE",
            "kind": "other", "status": "pending",
            "rawInput": {"_toolName": "task", "prompt": "Reply with exactly the word APPLE.", "description": "Subagent A replies APPLE"}
        }),
    );
    let card = cards(&events)[0].clone();
    assert_eq!(card.subagent_id, "call-c87a-0-fc_4949_0");
    assert_eq!(card.title, "Subagent A replies APPLE");
    assert_eq!(card.prompt, "Reply with exactly the word APPLE.");
    assert_eq!(card.status, SubagentStatus::Running);

    let events = apply(
        &mut subagents,
        MAIN,
        json!({
            "sessionUpdate": "subagent_spawned", "subagentSessionId": CHILD, "name": "generalPurpose",
            "task": "Reply with exactly", "capabilities": {},
            "_meta": {"cursor": {"toolCallId": TOOL, "agentId": CHILD, "model": "grok-4.7-high-fast"}}
        }),
    );
    let card = cards(&events)[0].clone();
    assert_eq!(card.agent_type, "generalPurpose");
    assert_eq!(card.model.as_deref(), Some("grok-4.7-high-fast"));
    // 截短的 task 不覆盖工具调用里的完整说明。
    assert_eq!(card.prompt, "Reply with exactly the word APPLE.");

    // 子会话自己的更新变成步骤，不进主时间线。
    let steps = apply(
        &mut subagents,
        CHILD,
        json!({"sessionUpdate": "tool_call", "toolCallId": "c1", "title": "`ls`", "kind": "execute", "status": "pending", "rawInput": {"command": "ls"}}),
    );
    assert!(matches!(&steps[0], SessionEventBody::SubagentStep { subagent_id, step }
        if subagent_id == "call-c87a-0-fc_4949_0" && matches!(**step, SessionEventBody::ToolCall { status: ToolStatus::Running, .. })));
    assert_eq!(cards(&steps)[0].activity, "ls");
    let steps = apply(
        &mut subagents,
        CHILD,
        json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "APPLE"}}),
    );
    assert!(matches!(&steps[0], SessionEventBody::SubagentStep { step, .. } if matches!(&**step, SessionEventBody::AgentMessage { text, .. } if text == "APPLE")));

    let events = apply(
        &mut subagents,
        MAIN,
        json!({"sessionUpdate": "subagent_state_update", "subagentSessionId": CHILD, "state": "completed",
               "_meta": {"cursor": {"toolCallId": TOOL, "agentId": CHILD, "model": "grok-4.7-high-fast"}}}),
    );
    let card = cards(&events)[0].clone();
    assert_eq!(card.status, SubagentStatus::Completed);
    assert_eq!(card.result, "APPLE");
    assert!(card.activity.is_empty());

    let events = apply(
        &mut subagents,
        MAIN,
        json!({"sessionUpdate": "tool_call_update", "toolCallId": TOOL, "status": "completed", "rawOutput": {"durationMs": 8737, "isBackground": false}}),
    );
    assert_eq!(cards(&events)[0].duration_ms, Some(8737));
    // 主会话的普通更新不认领。
    assert!(subagents
        .apply(MAIN, &json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "APPLE"}}))
        .is_none());
}

#[test]
fn background_task_waits_for_the_state_update_and_disconnect_stops() {
    let mut subagents = Subagents::new(Path::new(PROJECT));
    apply(
        &mut subagents,
        MAIN,
        json!({"sessionUpdate": "tool_call", "toolCallId": TOOL, "title": "Task: x", "kind": "other", "status": "pending",
               "rawInput": {"_toolName": "task", "prompt": "p", "description": "x"}}),
    );
    apply(
        &mut subagents,
        MAIN,
        json!({"sessionUpdate": "subagent_spawned", "subagentSessionId": CHILD, "name": "explore", "task": "p",
               "_meta": {"cursor": {"toolCallId": TOOL, "agentId": CHILD}}}),
    );
    let events = apply(
        &mut subagents,
        MAIN,
        json!({"sessionUpdate": "tool_call_update", "toolCallId": TOOL, "status": "completed", "rawOutput": {"durationMs": 5, "isBackground": true}}),
    );
    let card = cards(&events)[0].clone();
    assert!(card.background);
    assert_eq!(card.status, SubagentStatus::Running);
    let events = apply(
        &mut subagents,
        MAIN,
        json!({"sessionUpdate": "subagent_state_update", "subagentSessionId": CHILD, "state": "disconnected"}),
    );
    assert_eq!(cards(&events)[0].status, SubagentStatus::Stopped);
}

#[test]
fn stop_all_stops_only_running_cards() {
    let mut subagents = Subagents::new(Path::new(PROJECT));
    apply(
        &mut subagents,
        MAIN,
        json!({"sessionUpdate": "tool_call", "toolCallId": TOOL, "title": "Task: x", "kind": "other", "status": "pending",
               "rawInput": {"_toolName": "task", "prompt": "p", "description": "x"}}),
    );
    let stopped = subagents.stop_all();
    assert_eq!(cards(&stopped)[0].status, SubagentStatus::Stopped);
    assert!(subagents.stop_all().is_empty());
}

/// 2026-10 用户在正式包里遇到的：跑了 27 分钟后 Cursor 把后端异常当回答发出来。
#[test]
fn trailing_error_chunk_is_held_and_taken_as_the_turn_failure() {
    let mut map = UpdateMap::new(Path::new(PROJECT), &RULES);
    map.begin_turn("t1");
    let mut events = map.apply(&json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "已经检查了两个文件。"}}));
    events.extend(map.apply(&json!({"sessionUpdate": "agent_message_chunk",
        "content": {"type": "text", "text": "\n\nError: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)"}})));
    let texts: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::AgentMessage { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, ["已经检查了两个文件。"]);
    assert_eq!(
        map.take_error().as_deref(),
        Some("RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)")
    );
    assert_eq!(map.take_error(), None);
}

#[test]
fn error_text_followed_by_more_output_stays_part_of_the_answer() {
    let mut map = UpdateMap::new(Path::new(PROJECT), &RULES);
    map.begin_turn("t1");
    map.apply(&json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "日志里是"}}));
    map.apply(&json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "\n\nError: not found"}}));
    let events = map.apply(&json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "，已经修好。"}}));
    let SessionEventBody::AgentMessage { text, .. } = events.last().unwrap() else { panic!("{events:?}") };
    assert_eq!(text, "日志里是\n\nError: not found，已经修好。");
    assert_eq!(map.take_error(), None);
}

#[test]
fn replayed_turn_ending_in_error_is_failed() {
    let mut map = UpdateMap::new(Path::new(PROJECT), &RULES);
    let mut events = Vec::new();
    for update in [
        json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "审查一下"}}),
        json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "\n\nError: boom"}}),
    ] {
        events.extend(map.apply(&update));
    }
    events.extend(map.finish_replay());
    assert!(events.iter().any(|event| matches!(event, SessionEventBody::Error { message } if message.ends_with("boom"))));
    assert!(matches!(events.last(), Some(SessionEventBody::StatusChanged { status: SessionStatus::Failed })));
}

#[test]
fn replayed_user_messages_drop_the_workbench_instructions() {
    let mut map = UpdateMap::new(Path::new(PROJECT), &RULES);
    let sent = format!("{}审查一下", crate::acp::updates::wrap_instructions(crate::WorkbenchMcp::INSTRUCTIONS));
    let mut events = map.apply(&json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": sent}}));
    events.extend(map.finish_replay());
    assert!(events.iter().any(|event| matches!(event, SessionEventBody::UserMessage { text, .. } if text == "审查一下")), "{events:?}");
}

#[test]
fn workbench_tool_approvals_are_recognized_by_title() {
    let ours = json!({"toolCall": {"toolCallId": "x", "title": "aiwb: aiwb_subtask_create", "kind": "other"}});
    assert!(prompts::workbench_tool(&ours));
    let other = json!({"toolCall": {"toolCallId": "x", "title": "github: create_issue", "kind": "other"}});
    assert!(!prompts::workbench_tool(&other));
    let shell = json!({"toolCall": {"toolCallId": "x", "title": "`aiwb: aiwb_x`", "kind": "execute"}});
    assert!(!prompts::workbench_tool(&shell));
}
