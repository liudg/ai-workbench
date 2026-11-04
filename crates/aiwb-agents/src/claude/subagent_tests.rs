//! 子 Agent 的夹具。报文从 Claude Code 2.1.312（2026-11-04，haiku）实录里截出来，去掉了无关字段。

use aiwb_core::models::{SessionEventBody, SubagentCard, SubagentStatus, ToolStatus};

use super::messages::{self, ingest_line, MapState};

fn steps_of(events: &[SessionEventBody], id: &str) -> Vec<SessionEventBody> {
    events
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::SubagentStep { subagent_id, step } if subagent_id == id => Some((**step).clone()),
            _ => None,
        })
        .collect()
}

/// 除了用量、子 Agent 卡片和子 Agent 步骤以外的事件。
fn main_timeline(events: &[SessionEventBody]) -> Vec<&SessionEventBody> {
    events
        .iter()
        .filter(|event| {
            !matches!(
                event,
                SessionEventBody::SessionUsage { .. } | SessionEventBody::Subagent(_) | SessionEventBody::SubagentStep { .. }
            )
        })
        .collect()
}

fn last_card(events: &[SessionEventBody]) -> SubagentCard {
    events
        .iter()
        .rev()
        .find_map(|event| match event {
            SessionEventBody::Subagent(card) => Some(card.clone()),
            _ => None,
        })
        .expect("subagent card")
}

/// 实时流里子 Agent 的消息不带 `isSidechain`，只带 `parent_tool_use_id`：回答和工具挂到那个子 Agent 下面，
/// 不进主时间线，流式碎片不画，用量照记。
#[test]
fn live_subagent_messages_go_under_their_card() {
    let mut state = MapState::default();
    let reply = ingest_line(
        &mut state,
        r#"{"type":"assistant","parent_tool_use_id":"toolu_1","uuid":"aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa","message":{"id":"msg_sub","role":"assistant","content":[{"type":"text","text":"PONG"},{"type":"tool_use","id":"toolu_2","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":5,"output_tokens":1}}}"#,
        true,
        None,
    );
    assert!(reply.events.iter().any(|event| matches!(event, SessionEventBody::SessionUsage { .. })), "用量照记");
    let steps = steps_of(&reply.events, "toolu_1");
    assert!(steps.iter().any(|step| matches!(step, SessionEventBody::AgentMessage { text, .. } if text == "PONG")));
    assert!(steps.iter().any(|step| matches!(step, SessionEventBody::ToolCall { status: ToolStatus::Running, .. })));
    assert!(main_timeline(&reply.events).is_empty(), "{:?}", reply.events);
    let result = ingest_line(
        &mut state,
        r#"{"type":"user","parent_tool_use_id":"toolu_1","uuid":"aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","content":"a.txt"}]}}"#,
        true,
        None,
    );
    let steps = steps_of(&result.events, "toolu_1");
    assert!(
        matches!(steps.as_slice(), [SessionEventBody::ToolCall { detail, status: ToolStatus::Completed, .. }] if detail == "a.txt"),
        "{:?}",
        result.events
    );
    assert!(main_timeline(&result.events).is_empty());
    let delta = ingest_line(
        &mut state,
        r#"{"type":"stream_event","parent_tool_use_id":"toolu_1","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PO"}}}"#,
        true,
        None,
    );
    assert!(main_timeline(&delta.events).is_empty());
    let main = ingest_line(
        &mut state,
        r#"{"type":"assistant","parent_tool_use_id":null,"uuid":"aaaaaaaa-3333-4aaa-8aaa-aaaaaaaaaaaa","message":{"id":"msg_main","role":"assistant","content":[{"type":"text","text":"子 Agent 回了 PONG"}]}}"#,
        true,
        None,
    );
    assert!(main.events.iter().any(|event| matches!(event, SessionEventBody::AgentMessage { text, .. } if text == "子 Agent 回了 PONG")));
}

/// 前台派子 Agent：`Agent` 工具画成卡片，不是工具行；`task_*` 更新进度，工具结果带回结果、模型和用量。
#[test]
fn foreground_agent_tool_becomes_a_card() {
    let mut state = MapState::default();
    let spawn = ingest_line(
        &mut state,
        r#"{"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"tool_use","id":"toolu_P","name":"Agent","input":{"description":"Run echo PING","prompt":"Run `echo PING` and reply with its output.","subagent_type":"general-purpose","run_in_background":false}}]},"parent_tool_use_id":null,"uuid":"bbbbbbbb-0001-4bbb-8bbb-bbbbbbbbbbbb"}"#,
        true,
        None,
    );
    assert!(!spawn.events.iter().any(|event| matches!(event, SessionEventBody::ToolCall { .. })));
    let card = last_card(&spawn.events);
    assert_eq!(card.subagent_id, "toolu_P");
    assert_eq!(card.title, "Run echo PING");
    assert_eq!(card.agent_type, "general-purpose");
    assert_eq!(card.status, SubagentStatus::Running);
    assert!(card.started_at.is_some());

    let started = ingest_line(
        &mut state,
        r#"{"type":"system","subtype":"task_started","task_id":"a3f1","tool_use_id":"toolu_P","description":"Run echo PING","subagent_type":"general-purpose","is_backgrounded":false,"task_type":"local_agent","prompt":"Run `echo PING` and reply with its output."}"#,
        true,
        None,
    );
    assert_eq!(last_card(&started.events).status, SubagentStatus::Running);
    let progress = ingest_line(
        &mut state,
        r#"{"type":"system","subtype":"task_progress","task_id":"a3f1","tool_use_id":"toolu_P","description":"Running Run echo PING in the shell","usage":{"total_tokens":33778,"tool_uses":1,"duration_ms":4106},"last_tool_name":"Bash"}"#,
        true,
        None,
    );
    let card = last_card(&progress.events);
    assert_eq!(card.activity, "Running Run echo PING in the shell");
    assert_eq!(card.tool_uses, Some(1));

    let done = ingest_line(
        &mut state,
        r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_P","type":"tool_result","content":[{"type":"text","text":"[Subagent hand-back] ...\n  PING"}]}]},"parent_tool_use_id":null,"uuid":"bbbbbbbb-0002-4bbb-8bbb-bbbbbbbbbbbb","tool_use_result":{"status":"completed","agentId":"a3f1","agentType":"general-purpose","content":[{"type":"text","text":"<tools-used-before-summary>Bash</tools-used-before-summary>\n"},{"type":"text","text":"PING"}],"resolvedModel":"claude-haiku-5-5","totalDurationMs":8251,"totalTokens":36222,"totalToolUseCount":1}}"#,
        true,
        None,
    );
    assert!(main_timeline(&done.events).is_empty(), "{:?}", done.events);
    let card = last_card(&done.events);
    assert_eq!(card.status, SubagentStatus::Completed);
    assert_eq!(card.result, "PING");
    assert_eq!(card.model.as_deref(), Some("claude-haiku-5-5"));
    assert_eq!((card.tokens, card.tool_uses, card.duration_ms), (Some(36222), Some(1), Some(8251)));
    assert!(card.activity.is_empty());
    assert!(card.ended_at.is_some());
}

/// 后台子 Agent：工具结果只说已启动，卡片一直在跑，`task_notification` 才算完。
/// 子 Agent 自己起的命令任务不算子 Agent。
#[test]
fn background_agent_runs_until_its_notification() {
    let mut state = MapState::default();
    ingest_line(
        &mut state,
        r#"{"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"tool_use","id":"toolu_B","name":"Agent","input":{"description":"Run background sleep echo","prompt":"sleep 5 && echo BG","run_in_background":true}}]},"uuid":"cccccccc-0001-4ccc-8ccc-cccccccccccc"}"#,
        true,
        None,
    );
    ingest_line(
        &mut state,
        r#"{"type":"system","subtype":"task_started","task_id":"aac6","tool_use_id":"toolu_B","description":"Run background sleep echo","subagent_type":"general-purpose","is_backgrounded":true,"task_type":"local_agent"}"#,
        true,
        None,
    );
    let launched = ingest_line(
        &mut state,
        r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_B","type":"tool_result","content":[{"type":"text","text":"Async agent launched successfully."}]}]},"uuid":"cccccccc-0002-4ccc-8ccc-cccccccccccc","tool_use_result":{"isAsync":true,"status":"async_launched","agentId":"aac6","resolvedModel":"claude-haiku-5-5"}}"#,
        true,
        None,
    );
    let card = last_card(&launched.events);
    assert_eq!(card.status, SubagentStatus::Running);
    assert!(card.background);
    assert_eq!(card.agent_type, "general-purpose");
    let bash = ingest_line(
        &mut state,
        r#"{"type":"system","subtype":"task_started","task_id":"b6pn","owned_by_subagent":true,"tool_use_id":"toolu_inner","description":"Sleep","is_backgrounded":false,"parent_task_id":"aac6","task_type":"local_bash"}"#,
        true,
        None,
    );
    assert!(bash.events.is_empty());
    let notified = ingest_line(
        &mut state,
        r#"{"type":"system","subtype":"task_notification","task_id":"aac6","tool_use_id":"toolu_B","status":"completed","summary":"The shell output was: BG","usage":{"total_tokens":34978,"tool_uses":1,"duration_ms":11943}}"#,
        true,
        None,
    );
    let card = last_card(&notified.events);
    assert_eq!(card.status, SubagentStatus::Completed);
    assert_eq!(card.result, "The shell output was: BG");
    assert_eq!(card.duration_ms, Some(11943));
}

/// 读转录：后台子 Agent 结束时补的那条用户消息改卡片，不画用户气泡；子 Agent 自己的转录挂到卡片下面。
#[test]
fn transcript_restores_cards_and_subagent_steps() {
    let root = std::env::temp_dir().join(format!("claude-subagent-transcript-{}", std::process::id()));
    let dir = root.join("subagents");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("agent-a3f1.jsonl"),
        [
            r#"{"parentUuid":null,"isSidechain":true,"agentId":"a3f1","type":"user","message":{"role":"user","content":"Run echo PING"},"uuid":"dddddddd-0001-4ddd-8ddd-dddddddddddd"}"#,
            r#"{"parentUuid":"dddddddd-0001-4ddd-8ddd-dddddddddddd","isSidechain":true,"agentId":"a3f1","type":"assistant","message":{"id":"msg_s1","role":"assistant","content":[{"type":"tool_use","id":"toolu_s1","name":"Bash","input":{"command":"echo PING"}}]},"uuid":"dddddddd-0002-4ddd-8ddd-dddddddddddd"}"#,
            r#"{"parentUuid":"dddddddd-0002-4ddd-8ddd-dddddddddddd","isSidechain":true,"agentId":"a3f1","type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_s1","type":"tool_result","content":"PING"}]},"uuid":"dddddddd-0003-4ddd-8ddd-dddddddddddd"}"#,
            r#"{"parentUuid":"dddddddd-0003-4ddd-8ddd-dddddddddddd","isSidechain":true,"agentId":"a3f1","type":"assistant","message":{"id":"msg_s2","role":"assistant","content":[{"type":"text","text":"PING"}]},"uuid":"dddddddd-0004-4ddd-8ddd-dddddddddddd"}"#,
        ]
        .join("\n"),
    )
    .unwrap();
    let transcript = [
        r#"{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"派两个子 Agent"},"uuid":"eeeeeeee-0001-4eee-8eee-eeeeeeeeeeee","timestamp":"2026-11-04T05:03:30.000Z"}"#,
        r#"{"parentUuid":"eeeeeeee-0001-4eee-8eee-eeeeeeeeeeee","isSidechain":false,"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"tool_use","id":"toolu_P","name":"Agent","input":{"description":"Run echo PING","prompt":"Run echo PING"}}]},"uuid":"eeeeeeee-0002-4eee-8eee-eeeeeeeeeeee","timestamp":"2026-11-04T05:03:32.679Z"}"#,
        r#"{"parentUuid":"eeeeeeee-0002-4eee-8eee-eeeeeeeeeeee","isSidechain":false,"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"tool_use","id":"toolu_B","name":"Agent","input":{"description":"Background","prompt":"wait","run_in_background":true}}]},"uuid":"eeeeeeee-0003-4eee-8eee-eeeeeeeeeeee","timestamp":"2026-11-04T05:03:33.000Z"}"#,
        r#"{"parentUuid":"eeeeeeee-0003-4eee-8eee-eeeeeeeeeeee","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_P","type":"tool_result","content":[{"type":"text","text":"PING"}]}]},"uuid":"eeeeeeee-0004-4eee-8eee-eeeeeeeeeeee","timestamp":"2026-11-04T05:03:40.987Z","toolUseResult":{"status":"completed","agentId":"a3f1","content":[{"type":"text","text":"PING"}],"totalDurationMs":8251}}"#,
        r#"{"parentUuid":"eeeeeeee-0004-4eee-8eee-eeeeeeeeeeee","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_B","type":"tool_result","content":[{"type":"text","text":"Async agent launched successfully."}]}]},"uuid":"eeeeeeee-0005-4eee-8eee-eeeeeeeeeeee","timestamp":"2026-11-04T05:03:41.000Z","toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"bbbb"}}"#,
        r#"{"parentUuid":"eeeeeeee-0005-4eee-8eee-eeeeeeeeeeee","isSidechain":false,"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>bbbb</task-id>\n<tool-use-id>toolu_B</tool-use-id>\n<status>completed</status>\n<summary>Agent \"Background\" finished</summary>\n<result>BG</result>\n<usage><subagent_tokens>34978</subagent_tokens><tool_uses>1</tool_uses><duration_ms>11943</duration_ms></usage>\n</task-notification>"},"uuid":"eeeeeeee-0006-4eee-8eee-eeeeeeeeeeee","timestamp":"2026-11-04T05:04:26.099Z","origin":{"kind":"task-notification"}}"#,
    ]
    .join("\n");
    let mut state = MapState::default();
    state.subagent_dir = Some(dir);
    let events = messages::events_from_transcript(&mut state, &transcript, None);
    let users: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::UserMessage { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(users, ["派两个子 Agent"]);
    let steps = steps_of(&events, "toolu_P");
    assert!(steps.iter().any(|step| matches!(step, SessionEventBody::ToolCall { detail, .. } if detail == "PING")));
    assert!(steps.iter().any(|step| matches!(step, SessionEventBody::AgentMessage { text, .. } if text == "PING")));
    assert!(!steps.iter().any(|step| matches!(step, SessionEventBody::UserMessage { .. })));
    let card = |id: &str| {
        events
            .iter()
            .rev()
            .find_map(|event| match event {
                SessionEventBody::Subagent(card) if card.subagent_id == id => Some(card.clone()),
                _ => None,
            })
            .unwrap()
    };
    let foreground = card("toolu_P");
    assert_eq!(foreground.status, SubagentStatus::Completed);
    assert_eq!(foreground.started_at, Some(1_793_768_612_679));
    let background = card("toolu_B");
    assert_eq!(background.status, SubagentStatus::Completed);
    assert_eq!(background.result, "BG");
    assert_eq!(background.tokens, Some(34978));
    let _ = std::fs::remove_dir_all(root);
}
