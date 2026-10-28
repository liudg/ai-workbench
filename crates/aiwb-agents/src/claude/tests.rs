//! 夹具。报文按官方 stream-json / jsonl 的形状手写，不是这台机器抓到的会话。

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::json;

use super::catalog;
use super::command::{self, Launch};
use super::control::{self, PermissionKind};
use super::diff;
use super::history::{self, conversation_chain};
use super::images;
use super::messages::{self, ingest_line, MapState};
use super::mutate;
use super::permission::permission_menu;
use super::process;
use aiwb_core::models::{AgentKind, MessagePhase, PromptAnswer, SessionEventBody, SessionStatus};

fn temp_dir(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("claude-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn cli_args_follow_the_sdk_and_require_print() {
    let args = command::cli_args(&Launch {
        session_id: "abc".into(),
        resume: true,
        permission_mode: "bypassPermissions".into(),
        model: Some("sonnet".into()),
        effort: Some("high".into()),
        writable_roots: Vec::new(),
        worktree: None,
    });
    assert_eq!(
        args,
        vec![
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            "sonnet",
            "--permission-prompt-tool",
            "stdio",
            "--permission-mode",
            "bypassPermissions",
            "--resume=abc",
            "--include-partial-messages",
            "--setting-sources=user,project",
            "--effort",
            "high",
            "--allow-dangerously-skip-permissions",
            "--input-format",
            "stream-json",
        ]
    );
    let fresh = command::cli_args(&Launch {
        session_id: "id-1".into(),
        resume: false,
        permission_mode: "default".into(),
        model: None,
        effort: Some("  ".into()),
        writable_roots: Vec::new(),
        worktree: None,
    });
    assert!(fresh.iter().any(|arg| arg == "--session-id=id-1"));
    assert!(!fresh.iter().any(|arg| arg == "--model" || arg == "--effort"));
    assert!(!fresh.iter().any(|arg| arg == "--system-prompt"));
    assert!(!fresh.iter().any(|arg| arg == "--dangerously-skip-permissions"));
    assert!(fresh.iter().any(|arg| arg == "--allow-dangerously-skip-permissions"));
}

#[test]
fn add_dir_is_a_launch_argument() {
    let args = command::cli_args(&Launch {
        session_id: "id-1".into(),
        resume: false,
        permission_mode: "default".into(),
        model: None,
        effort: None,
        writable_roots: vec![r"D:\extra".into()],
        worktree: Some("feature-auth".into()),
    });
    let pos = args.iter().position(|arg| arg == "--add-dir").expect("add-dir");
    assert_eq!(args[pos + 1], r"D:\extra");
    assert_eq!(args[pos + 2], "--worktree");
    assert_eq!(args[pos + 3], "feature-auth");
    assert_eq!(args[pos + 4], "--input-format");
}

/// `Path` 只在 Windows 上把 `C:\work` 当成绝对路径。
#[test]
#[cfg(windows)]
fn add_dir_normalizes_against_the_workspace() {
    let normalized = command::normalize_add_dirs(
        r"C:\work",
        &[
            r"c:\work".into(),
            r"C:\work\extra".into(),
            r"C:\work\extra".into(),
            "  ".into(),
            "notes".into(),
        ],
    );
    assert_eq!(
        normalized,
        vec![r"C:\work\extra".to_string(), r"C:\work\notes".to_string()]
    );
}

#[test]
fn read_only_and_approve_for_me_are_not_sandbox_modes() {
    assert_eq!(command::permission_mode_for_access(Some("read-only")), "default");
    assert_eq!(command::permission_mode_for_access(Some("approve-for-me")), "default");
    assert_eq!(command::permission_mode_for_access(Some("full")), "bypassPermissions");
    assert!(command::access_to_permission_mode("read-only").is_err());
    assert!(command::access_to_permission_mode("approve-for-me").is_err());
    assert_eq!(command::access_to_permission_mode("full").unwrap(), "bypassPermissions");
}

#[test]
fn path_hash_matches_the_sdk_vector() {
    let xs = "X".repeat(201);
    assert_eq!(history::simple_hash(&xs), "umr0yw");
    assert_eq!(history::sanitize_path("/workspace/demo"), "-workspace-demo");
}

#[test]
fn initialize_and_control_response_match_the_sdk() {
    assert_eq!(
        control::initialize_request(),
        json!({"subtype": "initialize", "hooks": null})
    );
    let ok = json!({
        "type": "control_response",
        "response": {"subtype": "success", "request_id": "req_1_abcd", "response": {"commands": []}}
    });
    let (id, result) = control::parse_control_response(&ok).unwrap();
    assert_eq!(id, "req_1_abcd");
    assert_eq!(result.unwrap()["commands"], json!([]));
    let err = json!({
        "type": "control_response",
        "response": {"subtype": "error", "request_id": "req_2", "error": "nope"}
    });
    let (_, result) = control::parse_control_response(&err).unwrap();
    assert_eq!(result.unwrap_err(), "nope");
}

#[test]
fn permission_allow_deny_and_question_answers_use_question_text() {
    let input = json!({
        "questions": [{
            "question": "选哪个？",
            "header": "选择",
            "options": [{"label": "甲", "description": "第一项"}]
        }]
    });
    let request = json!({
        "subtype": "can_use_tool",
        "tool_name": "AskUserQuestion",
        "input": input,
    });
    let (events, kind) = messages::permission_events("req-q", &request).unwrap();
    match &events[0] {
        SessionEventBody::Prompt { prompt_kind, questions, .. } => {
            assert_eq!(*prompt_kind, aiwb_core::models::PromptKind::Questions);
            assert_eq!(questions[0].id, "q1");
            assert_eq!(questions[0].options[0].id, "甲");
            assert!(questions[0].is_other);
            assert!(!questions[0].multi_select);
        }
        other => panic!("unexpected {other:?}"),
    }
    let mut answers = HashMap::new();
    answers.insert("q1".into(), "甲".into());
    let result = control::permission_result(
        &kind,
        &PromptAnswer::Questions { answers, skipped: false },
    )
    .unwrap();
    assert_eq!(result["behavior"], "allow");
    assert_eq!(result["updatedInput"]["answers"]["选哪个？"], "甲");

    let skipped = control::permission_result(
        &kind,
        &PromptAnswer::Questions { answers: HashMap::new(), skipped: true },
    )
    .unwrap();
    assert_eq!(skipped["behavior"], "deny");
    assert_eq!(skipped["message"], "用户跳过了提问");

    let approval = PermissionKind::Approval { input: json!({"command": "ls"}) };
    let allow = control::permission_result(&approval, &PromptAnswer::Single { value: "approve".into() }).unwrap();
    assert_eq!(allow["behavior"], "allow");
    assert_eq!(allow["updatedInput"]["command"], "ls");
    let deny = control::permission_result(&approval, &PromptAnswer::Single { value: "reject".into() }).unwrap();
    assert_eq!(deny["behavior"], "deny");
    assert!(deny.get("updatedInput").is_none());
}

#[test]
fn ask_user_question_maps_multi_select_text_and_number() {
    let input = json!({
        "questions": [
            {
                "question": "要哪些？",
                "header": "功能",
                "multiSelect": true,
                "options": [
                    {"label": "甲", "description": "一"},
                    {"label": "乙 (Recommended)", "description": ""}
                ]
            },
            {"question": "补充？", "header": "备注", "kind": "text", "options": [{"label": "不该出现"}]},
            {"question": "几个？", "header": "数量", "kind": "number", "min": 1, "max": 4}
        ]
    });
    let questions = control::questions_from_input(&input);
    assert_eq!(questions.len(), 3);
    assert!(questions[0].multi_select);
    assert!(questions[0].is_other);
    assert!(questions[1].options.is_empty());
    assert!(!questions[1].is_other);
    assert!(questions[2].options.is_empty());
    assert_eq!(questions[2].input_kind, "number");
    let mut answers = HashMap::new();
    answers.insert("q1".into(), "甲, 乙 (Recommended)".into());
    let request = json!({"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "input": input});
    let (_, kind) = messages::permission_events("req-multi", &request).unwrap();
    let result = control::permission_result(
        &kind,
        &PromptAnswer::Questions { answers, skipped: false },
    )
    .unwrap();
    assert_eq!(result["updatedInput"]["answers"]["要哪些？"], "甲, 乙 (Recommended)");
}

#[test]
fn exit_plan_mode_is_an_approval_card() {
    let request = json!({
        "subtype": "can_use_tool",
        "tool_name": "ExitPlanMode",
        "input": {"plan": "先改测试", "planFilePath": "/tmp/plan.md"}
    });
    let (events, kind) = messages::permission_events("req-plan", &request).unwrap();
    assert!(matches!(events[0], SessionEventBody::PlanText { ref text, .. } if text == "先改测试"));
    match &events[1] {
        SessionEventBody::Prompt { question, options, .. } => {
            assert_eq!(question, "退出计划模式？");
            assert_eq!(options[0].label, "允许一次");
            assert_eq!(options[0].slot, "primary");
            assert_eq!(options[1].id, "reject");
            assert_eq!(options[1].slot, "deny");
        }
        other => panic!("unexpected {other:?}"),
    }
    let allow = control::permission_result(&kind, &PromptAnswer::Single { value: "允许".into() }).unwrap();
    assert_eq!(allow["updatedInput"]["plan"], "先改测试");
}

#[test]
fn stream_fixture_maps_bash_edit_usage_and_goal() {
    let mut state = MapState::default();
    let init = ingest_line(
        &mut state,
        r#"{"type":"system","subtype":"init","model":"claude-sonnet"}"#,
        true,
        None,
    );
    assert!(init.events.is_empty());
    assert_eq!(state.model.as_deref(), Some("claude-sonnet"));

    let bash = ingest_line(
        &mut state,
        r#"{"type":"assistant","uuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"role":"assistant","content":[{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"ls"}}]}}"#,
        true,
        None,
    );
    match &bash.events[0] {
        SessionEventBody::ToolCall { name, summary, stream_id, .. } => {
            assert_eq!(name, "command");
            assert_eq!(summary, "ls");
            assert_eq!(stream_id.as_deref(), Some("tool-1"));
        }
        other => panic!("unexpected {other:?}"),
    }

    state.begin_turn("turn-1");
    let edit = ingest_line(
        &mut state,
        r#"{"type":"assistant","uuid":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","message":{"role":"assistant","content":[{"type":"tool_use","id":"tool-2","name":"Edit","input":{"file_path":"src/a.txt","old_string":"old","new_string":"new"}}]}}"#,
        true,
        None,
    );
    // 还没跑（可能在等审批）的改动不算变更。
    assert!(!edit
        .events
        .iter()
        .any(|event| matches!(event, SessionEventBody::FileChange { .. })));
    let applied = ingest_line(
        &mut state,
        r#"{"type":"user","uuid":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-2","content":"The file src/a.txt has been updated."}]}}"#,
        true,
        None,
    );
    let diff = applied.events.iter().find_map(|event| match event {
        SessionEventBody::FileChange { diff, path, .. } => Some((path.as_str(), diff.as_str())),
        _ => None,
    });
    let (path, diff) = diff.expect("edit diff");
    assert_eq!(path, "src/a.txt");
    assert!(diff.contains("--- a/src/a.txt"), "{diff}");
    assert!(diff.contains("+++ b/src/a.txt"), "{diff}");
    assert!(diff.contains("-old"), "{diff}");
    assert!(diff.contains("+new"), "{diff}");

    let echoed = ingest_line(
        &mut state,
        r#"{"type":"user","uuid":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","message":{"role":"user","content":"hello"}}"#,
        false,
        None,
    );
    assert!(matches!(echoed.events[0], SessionEventBody::UserMessage { ref text, .. } if text == "hello"));
    let again = ingest_line(
        &mut state,
        r#"{"type":"user","uuid":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","message":{"role":"user","content":"hello"}}"#,
        true,
        None,
    );
    assert!(again.events.is_empty());

    let result = ingest_line(
        &mut state,
        r#"{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":3,"output_tokens":4}}"#,
        true,
        None,
    );
    let usage = result.events.iter().find_map(|event| match event {
        SessionEventBody::ContextUsage { source, used_tokens, max_tokens, percentage, input_tokens, output_tokens, .. } => {
            Some((source.as_str(), *used_tokens, *max_tokens, *percentage, *input_tokens, *output_tokens))
        }
        _ => None,
    }).expect("usage");
    assert_eq!(usage, ("partial-usage", None, None, None, Some(3), Some(4)));
    assert!(result.events.iter().all(|event| !matches!(event, SessionEventBody::SessionUsage { .. })));
    assert!(result.events.iter().any(|event| matches!(
        event,
        SessionEventBody::StatusChanged { status: SessionStatus::Completed }
    )));

    let replay = ingest_line(
        &mut state,
        r#"{"type":"result","subtype":"success","usage":{"input_tokens":1,"output_tokens":1}}"#,
        false,
        None,
    );
    assert!(!replay.events.iter().any(|event| matches!(event, SessionEventBody::StatusChanged { .. })));
    assert!(!replay.events.iter().any(|event| matches!(event, SessionEventBody::SessionUsage { .. })));

    let mut side_state = MapState::default();
    let main = ingest_line(
        &mut side_state,
        r#"{"type":"assistant","uuid":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","message":{"id":"msg_main","role":"assistant","content":[{"type":"text","text":"主循环"}],"usage":{"input_tokens":8,"output_tokens":1}}}"#,
        true,
        None,
    );
    match main.events.iter().find(|event| matches!(event, SessionEventBody::SessionUsage { .. })) {
        Some(SessionEventBody::SessionUsage { scope, key, input_tokens, output_tokens, .. }) => {
            assert_eq!(scope, "delta");
            assert_eq!(key.as_deref(), Some("assistant:msg_main"));
            assert_eq!(*input_tokens, Some(8));
            assert_eq!(*output_tokens, Some(1));
        }
        other => panic!("main usage missing: {other:?}"),
    }
    let side = ingest_line(
        &mut side_state,
        r#"{"type":"assistant","uuid":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","isSidechain":true,"message":{"id":"msg_side","role":"assistant","content":[{"type":"text","text":"旁路"}],"usage":{"input_tokens":8,"output_tokens":1,"cache_read_input_tokens":2}}}"#,
        true,
        None,
    );
    match side.events.iter().find(|event| matches!(event, SessionEventBody::SessionUsage { .. })) {
        Some(SessionEventBody::SessionUsage { scope, key, input_tokens, output_tokens, cache_read_tokens, .. }) => {
            assert_eq!(scope, "delta");
            assert_eq!(key.as_deref(), Some("assistant:msg_side"));
            assert_eq!(*input_tokens, Some(8));
            assert_eq!(*output_tokens, Some(1));
            assert_eq!(*cache_read_tokens, Some(2));
        }
        other => panic!("subagent usage missing: {other:?}"),
    }
    let repeated = ingest_line(
        &mut side_state,
        r#"{"type":"assistant","uuid":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","isSidechain":true,"message":{"id":"msg_side","usage":{"input_tokens":8,"output_tokens":1}}}"#,
        true,
        None,
    );
    assert!(repeated.events.is_empty());

    let mut resumed = MapState::default();
    let side_line = r#"{"type":"assistant","uuid":"ffffffff-ffff-4fff-8fff-ffffffffffff","isSidechain":true,"message":{"id":"msg_old","content":[{"type":"text","text":"旧旁路"}],"usage":{"input_tokens":8,"output_tokens":1,"cache_read_input_tokens":2}}}"#;
    let history = messages::events_from_transcript(&mut resumed, side_line, None);
    assert!(history.iter().all(|event| !matches!(event, SessionEventBody::SessionUsage { .. })));
    let echo = ingest_line(&mut resumed, side_line, true, None);
    assert!(echo.events.is_empty());

    let cleared = ingest_line(&mut state, r#"{"type":"active_goal","value":null}"#, true, None);
    match &cleared.events[0] {
        SessionEventBody::Goal { objective, token_budget, .. } => {
            assert!(objective.is_none());
            assert!(token_budget.is_none());
        }
        other => panic!("unexpected {other:?}"),
    }
    let goal = ingest_line(
        &mut state,
        r#"{"type":"active_goal","value":{"condition":"tests pass","iterations":1}}"#,
        true,
        None,
    );
    match &goal.events[0] {
        SessionEventBody::Goal { objective, status, token_budget, tokens_used, .. } => {
            assert_eq!(objective.as_deref(), Some("tests pass"));
            assert_eq!(status.as_deref(), Some("active"));
            assert!(token_budget.is_none());
            assert!(tokens_used.is_none());
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn recorded_claude_jsonl_matches_live_and_does_not_add_result() {
    let resumed = super::usage::snapshot_from_transcript(super::usage::RECORDED_CLAUDE_JSONL).expect("snapshot");
    let mut state = MapState::default();
    let mut usage = Vec::new();
    for line in super::usage::RECORDED_CLAUDE_LIVE.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(line).unwrap();
        let is_result = value.get("type").and_then(|kind| kind.as_str()) == Some("result");
        let ingested = ingest_line(&mut state, line, true, None);
        if is_result {
            assert!(ingested.events.iter().any(|event| matches!(
                event,
                SessionEventBody::ContextUsage { source, input_tokens, output_tokens, .. }
                    if source == "partial-usage" && *input_tokens == Some(9999) && *output_tokens == Some(9999)
            )));
            assert!(ingested.events.iter().all(|event| !matches!(event, SessionEventBody::SessionUsage { .. })));
            continue;
        }
        usage.extend(ingested.events.into_iter().filter(|event| matches!(event, SessionEventBody::SessionUsage { .. })));
    }
    assert_eq!(usage_parts(&resumed), fold_usage(&usage));
    assert_eq!(usage_parts(&resumed), (Some(15), Some(126), Some(17_400), Some(1_200)));
}

fn usage_parts(body: &SessionEventBody) -> (Option<i64>, Option<i64>, Option<i64>, Option<i64>) {
    match body {
        SessionEventBody::SessionUsage { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, .. } => {
            (*input_tokens, *output_tokens, *cache_read_tokens, *cache_write_tokens)
        }
        other => panic!("expected session usage, got {other:?}"),
    }
}

fn fold_usage(events: &[SessionEventBody]) -> (Option<i64>, Option<i64>, Option<i64>, Option<i64>) {
    let mut baseline = None;
    let mut deltas = HashMap::<String, (Option<i64>, Option<i64>, Option<i64>, Option<i64>)>::new();
    for event in events {
        let SessionEventBody::SessionUsage { scope, key, .. } = event else {
            continue;
        };
        let parts = usage_parts(event);
        if scope == "snapshot" {
            baseline = Some(parts);
            deltas.clear();
            continue;
        }
        deltas.insert(key.clone().unwrap_or_default(), parts);
    }
    let mut total = baseline.unwrap_or((None, None, None, None));
    for parts in deltas.values() {
        total = (add_opt(total.0, parts.0), add_opt(total.1, parts.1), add_opt(total.2, parts.2), add_opt(total.3, parts.3));
    }
    total
}

fn add_opt(left: Option<i64>, right: Option<i64>) -> Option<i64> {
    match (left, right) {
        (None, None) => None,
        (value, None) | (None, value) => value,
        (Some(left), Some(right)) => Some(left.saturating_add(right.max(0))),
    }
}

#[test]
fn partial_text_is_one_stream() {
    let mut state = MapState::default();
    let first = ingest_line(
        &mut state,
        r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}}"#,
        true,
        None,
    );
    let second = ingest_line(
        &mut state,
        r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}}"#,
        true,
        None,
    );
    match (&first.events[0], &second.events[0]) {
        (
            SessionEventBody::AgentMessage { text, stream_id, phase, .. },
            SessionEventBody::AgentMessage { text: next, stream_id: next_id, .. },
        ) => {
            assert_eq!(text, "你");
            assert_eq!(next, "你好");
            assert_eq!(stream_id, next_id);
            assert_ne!(stream_id.as_deref(), Some("assistant"));
            assert_eq!(*phase, Some(MessagePhase::PartialAnswer));
        }
        _ => panic!("partial text missing"),
    }
}

#[test]
fn assistant_streams_stay_inside_one_message_and_do_not_cross_turns() {
    let mut state = MapState::default();
    state.begin_turn("turn-1");
    let partial = ingest_line(
        &mut state,
        r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}}"#,
        true,
        None,
    );
    let thinking = ingest_line(
        &mut state,
        r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"想"}}}"#,
        true,
        None,
    );
    let finished = ingest_line(
        &mut state,
        r#"{"type":"assistant","uuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","message":{"id":"msg_1","role":"assistant","content":[{"type":"thinking","thinking":"想完"},{"type":"text","text":"你好"}]}}"#,
        true,
        None,
    );
    let partial_id = agent_stream_id(&partial.events);
    let final_id = agent_stream_id(&finished.events);
    assert_eq!(partial_id, "assistant:turn-1:1");
    assert_eq!(final_id, partial_id);
    assert_eq!(thinking_stream_id(&thinking.events), "thinking:turn-1:2");
    assert_eq!(thinking_stream_id(&finished.events), "thinking:turn-1:2");

    let second = ingest_line(
        &mut state,
        r#"{"type":"assistant","uuid":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","message":{"role":"assistant","content":[{"type":"text","text":"接着说"}]}}"#,
        true,
        None,
    );
    assert_eq!(agent_stream_id(&second.events), "assistant:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    state.begin_turn("turn-2");
    let next = ingest_line(
        &mut state,
        r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"新"}}}"#,
        true,
        None,
    );
    let next_thinking = ingest_line(
        &mut state,
        r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"再想"}}}"#,
        true,
        None,
    );
    assert_ne!(agent_stream_id(&next.events), partial_id);
    assert_eq!(agent_stream_id(&next.events), "assistant:turn-2:3");
    assert_ne!(thinking_stream_id(&next_thinking.events), thinking_stream_id(&thinking.events));

    let user_a = "11111111-1111-4111-8111-111111111111";
    let assistant_a = "22222222-2222-4222-8222-222222222222";
    let user_b = "33333333-3333-4333-8333-333333333333";
    let assistant_b = "44444444-4444-4444-8444-444444444444";
    let transcript = format!(
        "{}\n{}\n{}\n{}\n",
        json!({"type":"user","uuid":user_a,"parentUuid":null,"message":{"role":"user","content":"介绍一下自己"}}),
        json!({"type":"assistant","uuid":assistant_a,"parentUuid":user_a,"message":{"role":"assistant","content":[{"type":"text","text":"我是上一轮"}]}}),
        json!({"type":"user","uuid":user_b,"parentUuid":assistant_a,"message":{"role":"user","content":"再说一次"}}),
        json!({"type":"assistant","uuid":assistant_b,"parentUuid":user_b,"message":{"role":"assistant","content":[{"type":"text","text":"我是这一轮"}]}}),
    );
    let mut history = MapState::default();
    let events = messages::events_from_transcript(&mut history, &transcript, None);
    let ids: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::AgentMessage { stream_id, text, .. } => Some((text.as_str(), stream_id.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        ids,
        vec![
            ("我是上一轮", Some(format!("assistant:{assistant_a}"))),
            ("我是这一轮", Some(format!("assistant:{assistant_b}"))),
        ]
    );
}

fn agent_stream_id(events: &[SessionEventBody]) -> String {
    events
        .iter()
        .find_map(|event| match event {
            SessionEventBody::AgentMessage { stream_id, .. } => stream_id.clone(),
            _ => None,
        })
        .expect("assistant stream")
}

fn thinking_stream_id(events: &[SessionEventBody]) -> String {
    events
        .iter()
        .find_map(|event| match event {
            SessionEventBody::Thinking { stream_id, .. } => stream_id.clone(),
            _ => None,
        })
        .expect("thinking stream")
}

#[test]
fn history_chain_skips_sidechain_and_custom_title_wins() {
    let side = "33333333-3333-4333-8333-333333333333";
    let user = "11111111-1111-4111-8111-111111111111";
    let assistant = "22222222-2222-4222-8222-222222222222";
    let content = format!(
        "{}\n{}\n{}\n",
        json!({"type":"user","uuid":user,"parentUuid":null,"cwd":"/workspace/demo","timestamp":"2026-01-02T03:04:05Z","message":{"role":"user","content":"hello"}}),
        json!({"type":"assistant","uuid":assistant,"parentUuid":user,"message":{"role":"assistant","content":[{"type":"text","text":"world"}]}}),
        json!({"type":"user","uuid":side,"parentUuid":null,"isSidechain":true,"message":{"role":"user","content":"side"}}),
    );
    let entries = history::transcript_entries(&content);
    let chain = conversation_chain(&entries);
    let texts: Vec<_> = chain
        .iter()
        .map(|entry| entry["message"]["content"].as_str().unwrap_or("").to_string())
        .filter(|text| !text.is_empty())
        .collect();
    assert_eq!(texts, vec!["hello".to_string()]);
    assert!(chain.iter().all(|entry| {
        entry.get("uuid").and_then(|value| value.as_str()) != Some(side)
            && !entry.get("isSidechain").and_then(|value| value.as_bool()).unwrap_or(false)
    }));

    let mut state = MapState::default();
    let events = messages::events_from_transcript(&mut state, &content, None);
    let rendered: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::UserMessage { text, .. } => Some(text.as_str()),
            SessionEventBody::AgentMessage { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(rendered, vec!["hello", "world"]);

    let root = temp_dir("sessions");
    let project = root.join("-workspace-demo");
    std::fs::create_dir_all(&project).unwrap();
    let id = "44444444-4444-4444-8444-444444444444";
    let path = project.join(format!("{id}.jsonl"));
    let mut file = content.clone();
    file.push_str(&json!({"type":"custom-title","customTitle":"自定义","sessionId":id,"aiTitle":"不要用这个"}).to_string());
    file.push('\n');
    std::fs::write(&path, file).unwrap();
    let listed = history::list_sessions_under(&root);
    let found = listed.iter().find(|item| item.session_id == id).expect("listed");
    assert_eq!(found.title, "自定义");
    assert_eq!(found.cwd, "/workspace/demo");
    mutate::append_custom_title_at(&path, id, "再次改名").unwrap();
    let listed = history::list_sessions_under(&root);
    assert_eq!(listed.iter().find(|item| item.session_id == id).unwrap().title, "再次改名");

    let side_id = "55555555-5555-4555-8555-555555555555";
    std::fs::write(
        project.join(format!("{side_id}.jsonl")),
        "{\"type\":\"user\",\"uuid\":\"66666666-6666-4666-8666-666666666666\",\"isSidechain\":true,\"message\":{\"role\":\"user\",\"content\":\"hidden\"}}\n",
    )
    .unwrap();
    assert!(history::list_sessions_under(&root).iter().all(|item| item.session_id != side_id));

    let source = project.join(format!("{id}.jsonl"));
    let mut with_echo = std::fs::read_to_string(&source).unwrap();
    with_echo.push_str(
        &json!({
            "type": "user",
            "uuid": "77777777-7777-4777-8777-777777777777",
            "sessionId": id,
            "session_id": id,
            "message": {"role": "user", "content": format!("正文里保留 {id}")}
        })
        .to_string(),
    );
    with_echo.push('\n');
    std::fs::write(&source, &with_echo).unwrap();
    let forked = history::fork_under(&source, id).unwrap();
    assert_ne!(forked.session_id, id);
    assert_eq!(forked.title, "再次改名");
    let child = std::fs::read_to_string(project.join(format!("{}.jsonl", forked.session_id))).unwrap();
    assert!(child.contains(&format!("\"sessionId\":\"{}\"", forked.session_id)));
    assert!(child.contains(&format!("正文里保留 {id}")));
    assert!(!child.contains(&format!("\"sessionId\":\"{id}\"")));
    assert!(std::fs::read_to_string(&source).unwrap().contains(&format!("\"sessionId\":\"{id}\"")));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn catalog_uses_reported_fields_and_permission_menu_is_honest() {
    let mut catalog = catalog::empty_catalog();
    catalog::apply_initialize(
        &mut catalog,
        &json!({
            "commands": [{"name": "review", "description": "审查", "argumentHint": "<target>"}],
            "models": [{"value": "claude-sonnet", "displayName": "Sonnet", "description": "平衡", "supportedEffortLevels": ["low", "high"]}]
        }),
        Some("claude-opus"),
    );
    assert!(catalog.skills.is_empty());
    assert_eq!(catalog.commands[0].name, "/review");
    assert!(catalog.commands[0].takes_args);
    assert_eq!(catalog.thread_model.as_deref(), Some("claude-opus"));
    assert_eq!(catalog.cli_config_read, Some(true));
    assert_eq!(catalog.models[0].id, "claude-opus");
    assert!(catalog.models[0].is_default);
    assert_eq!(catalog.models[1].label, "Sonnet");
    assert_eq!(catalog.models[1].efforts.len(), 2);
    assert!(catalog.models[1].default_effort.is_empty());

    catalog::apply_model_list(&mut catalog, &json!({"models": []}));
    assert_eq!(catalog.models.len(), 2);
    catalog::apply_settings(&mut catalog, &json!({"applied": {"model": "other", "effort": null}}));
    assert_eq!(catalog.thread_model.as_deref(), Some("claude-opus"));
    assert!(catalog.thread_effort.is_none());
    catalog::apply_settings(&mut catalog, &json!({"applied": {"effort": "high"}}));
    assert_eq!(catalog.thread_effort.as_deref(), Some("high"));

    let menu = permission_menu("ask");
    assert!(!menu.network_access);
    assert!(menu.writable_roots);
    assert!(!menu.permission_profiles);
    assert!(!menu.approve_for_me);
    assert_eq!(menu.presets.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), vec!["full", "ask"]);
    assert!(menu.presets.iter().all(|item| item.allows_extras));
    assert!(menu.presets.iter().find(|item| item.id == "full").unwrap().caution);
    assert_eq!(menu.active.as_deref(), Some("ask"));
    assert!(menu.notice.is_none());
    assert!(catalog.models.iter().all(|model| model.service_tiers.is_empty()));
    assert_eq!(catalog.agent, Some(AgentKind::ClaudeCode));
}

#[test]
fn settings_resolved_model_maps_to_alias_keeping_efforts() {
    let mut catalog = catalog::empty_catalog();
    catalog::apply_model_list(
        &mut catalog,
        &json!({
            "models": [
                {
                    "value": "default",
                    "resolvedModel": "gpt-6.1-sol[1m]",
                    "displayName": "Default (recommended)",
                    "supportedEffortLevels": ["low", "high"]
                },
                {
                    "value": "opus",
                    "resolvedModel": "gpt-6.1-sol",
                    "displayName": "gpt-6.1-sol",
                    "description": "Custom Opus model",
                    "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"]
                }
            ]
        }),
    );
    assert_eq!(catalog.models.len(), 2);
    assert!(catalog.models.iter().all(|model| !model.is_default));

    catalog::apply_settings(
        &mut catalog,
        &json!({
            "effective": { "model": "sonnet", "effortLevel": "high" },
            "applied": { "model": "gpt-6.1-sol", "effort": "high" }
        }),
    );
    assert_eq!(catalog.thread_model.as_deref(), Some("opus"));
    assert_eq!(catalog.thread_effort.as_deref(), Some("high"));
    assert_eq!(catalog.models.len(), 2);
    let opus = catalog.models.iter().find(|model| model.id == "opus").unwrap();
    assert!(opus.is_default);
    assert_eq!(opus.efforts.len(), 5);
    assert_eq!(opus.resolved_model, "gpt-6.1-sol");
    assert!(catalog.models.iter().all(|model| model.id != "gpt-6.1-sol"));
}

#[test]
fn bracketed_resolved_model_still_maps_without_placeholder() {
    let mut catalog = catalog::empty_catalog();
    catalog::apply_initialize(
        &mut catalog,
        &json!({
            "models": [{
                "value": "default",
                "resolvedModel": "gpt-6.1-sol[1m]",
                "displayName": "Default (recommended)",
                "supportedEffortLevels": ["low", "medium", "high"]
            }]
        }),
        Some("gpt-6.1-sol[1m]"),
    );
    assert_eq!(catalog.thread_model.as_deref(), Some("default"));
    assert_eq!(catalog.models.len(), 1);
    assert_eq!(catalog.models[0].efforts.len(), 3);
}

#[test]
fn bracketed_name_does_not_steal_the_unbracketed_alias() {
    let mut catalog = catalog::empty_catalog();
    catalog::apply_model_list(
        &mut catalog,
        &json!({
            "models": [
                {
                    "value": "default",
                    "resolvedModel": "gpt-6.1-sol[1m]",
                    "displayName": "Default (recommended)",
                    "supportedEffortLevels": ["low", "high"]
                },
                {
                    "value": "opus",
                    "resolvedModel": "gpt-6.1-sol",
                    "displayName": "gpt-6.1-sol",
                    "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"]
                }
            ]
        }),
    );
    catalog::apply_settings(
        &mut catalog,
        &json!({"applied": {"model": "gpt-6.1-sol[1m]"}}),
    );
    assert_eq!(catalog.thread_model.as_deref(), Some("default"));
    assert_eq!(catalog.models.len(), 2);
    assert!(catalog.models.iter().find(|model| model.id == "default").unwrap().is_default);
    assert!(!catalog.models.iter().find(|model| model.id == "opus").unwrap().is_default);
}

#[test]
fn model_list_reads_id_aliases_and_effort_objects() {
    let mut catalog = catalog::empty_catalog();
    catalog::apply_model_list(
        &mut catalog,
        &json!([{
            "model": "claude-haiku",
            "label": "Haiku",
            "supportedEffortLevels": [
                "medium",
                {"id": "high", "description": "更深", "displayName": "高"}
            ]
        }]),
    );
    assert_eq!(catalog.models[0].id, "claude-haiku");
    assert_eq!(catalog.models[0].label, "Haiku");
    assert_eq!(catalog.models[0].efforts[0].id, "medium");
    assert!(catalog.models[0].efforts[0].label.is_none());
    assert_eq!(catalog.models[0].efforts[1].description, "更深");
    assert_eq!(catalog.models[0].efforts[1].label.as_deref(), Some("高"));
    assert_eq!(catalog.agent, Some(AgentKind::ClaudeCode));
}

#[test]
fn images_reject_remote_and_unknown_types() {
    let err = images::image_block("https://example.com/a.png").unwrap_err();
    assert!(err.to_string().contains("网络地址"));
    let err = images::image_block("/tmp/notes.txt").unwrap_err();
    assert!(err.to_string().contains("不支持的图片类型"));
    let block = images::image_block("data:image/png;base64,aGk=").unwrap();
    assert_eq!(block["source"]["media_type"], "image/png");
    assert_eq!(block["source"]["data"], "aGk=");
    assert_eq!(images::base64_encode(b"hi"), "aGk=");
    let text = images::message_content("看图", &[]).unwrap();
    assert_eq!(text, json!("看图"));
}

#[test]
fn stopped_result_follows_abort_reason() {
    let mut state = MapState::default();
    let ingest = ingest_line(
        &mut state,
        r#"{"type":"result","subtype":"error_during_execution","terminal_reason":"aborted_user","is_error":true}"#,
        true,
        None,
    );
    assert!(ingest.events.iter().any(|event| matches!(
        event,
        SessionEventBody::StatusChanged { status: SessionStatus::Stopped }
    )));
    assert!(!ingest.events.iter().any(|event| matches!(event, SessionEventBody::Error { .. })));

    // 用户按下停止后，CLI 仍报 aborted_streaming。这不是断线，会话要能继续发。
    let mut stopped = MapState::default();
    stopped.request_user_stop();
    let streaming = ingest_line(
        &mut stopped,
        r#"{"type":"result","subtype":"error_during_execution","terminal_reason":"aborted_streaming","is_error":true}"#,
        true,
        None,
    );
    assert!(!streaming.events.iter().any(|event| matches!(
        event,
        SessionEventBody::Error { message } if message.contains("连接中断")
    )));
    assert!(!streaming.events.iter().any(|event| matches!(event, SessionEventBody::Error { .. })));
    assert!(streaming.events.iter().any(|event| matches!(
        event,
        SessionEventBody::StatusChanged { status: SessionStatus::Completed }
    )));
    let mut tools = MapState::default();
    tools.request_user_stop();
    let tool_abort = ingest_line(
        &mut tools,
        r#"{"type":"result","subtype":"error_during_execution","terminal_reason":"aborted_tools","is_error":true}"#,
        true,
        None,
    );
    assert!(!tool_abort.events.iter().any(|event| matches!(event, SessionEventBody::Error { .. })));

    // 停止标记用完。下一次同样的流中止仍是断线。
    let later = ingest_line(
        &mut stopped,
        r#"{"type":"result","subtype":"error_during_execution","terminal_reason":"aborted_streaming","is_error":true}"#,
        true,
        None,
    );
    assert!(later.events.iter().any(|event| matches!(
        event,
        SessionEventBody::Error { message } if message.contains("连接中断")
    )));

    // 占位 unknown 在停止后也不会画成断线。带具体正文的接口错误仍然画。
    let mut opaque = MapState::default();
    opaque.request_user_stop();
    let unknown = ingest_line(
        &mut opaque,
        r#"{"type":"result","subtype":"error_during_execution","is_error":true,"error":"unknown"}"#,
        true,
        None,
    );
    assert!(!unknown.events.iter().any(|event| matches!(
        event,
        SessionEventBody::Error { message } if message.contains("连接中断")
    )));
    let mut concrete = MapState::default();
    concrete.request_user_stop();
    let dropped = ingest_line(
        &mut concrete,
        r#"{"type":"result","subtype":"error_during_execution","is_error":true,"error":{"formatted":"Connection dropped (ECONNRESET)"}}"#,
        true,
        None,
    );
    assert!(dropped.events.iter().any(|event| matches!(
        event,
        SessionEventBody::Error { message } if message.contains("ECONNRESET")
    )));
}

#[test]
fn api_error_object_is_a_retry_note() {
    let mut state = MapState::default();
    let ingest = ingest_line(
        &mut state,
        r#"{"type":"system","subtype":"api_error","level":"error","error":{"message":"Connection error.","formatted":"Connection dropped (ECONNRESET)","connection":{"message":"ECONNRESET"}},"retryAttempt":1,"maxRetries":10}"#,
        true,
        None,
    );
    match ingest.events.as_slice() {
        [SessionEventBody::System { text }] => {
            assert!(text.contains("Connection dropped (ECONNRESET)"));
            assert!(!text.to_ascii_lowercase().contains("unknown"));
        }
        other => panic!("expected one system note, got {other:?}"),
    }
    let again = ingest_line(
        &mut state,
        r#"{"type":"system","subtype":"api_error","error":{"formatted":"Connection dropped (ECONNRESET)"},"retryAttempt":2,"maxRetries":10}"#,
        true,
        None,
    );
    assert!(again.events.is_empty());
}

#[test]
fn string_unknown_api_error_is_not_shown_as_unknown() {
    let mut state = MapState::default();
    let ingest = ingest_line(
        &mut state,
        r#"{"type":"system","subtype":"api_error","error":"unknown","retryAttempt":1,"maxRetries":10}"#,
        true,
        None,
    );
    match ingest.events.as_slice() {
        [SessionEventBody::System { text }] => {
            assert!(text.contains("连接中断"));
            assert!(text.contains("正在重试"));
            assert!(!text.to_ascii_lowercase().contains("unknown"));
            assert!(!text.contains("报错"));
        }
        other => panic!("expected one system note, got {other:?}"),
    }
}

#[test]
fn string_unknown_system_error_is_not_a_red_banner() {
    let mut state = MapState::default();
    let ingest = ingest_line(
        &mut state,
        r#"{"type":"system","subtype":"error","error":"unknown"}"#,
        true,
        None,
    );
    assert!(!ingest.events.iter().any(|event| matches!(event, SessionEventBody::Error { .. })));
    match ingest.events.as_slice() {
        [SessionEventBody::System { text }] => {
            assert!(text.contains("连接中断"));
            assert!(!text.contains("报错"));
            assert!(!text.to_ascii_lowercase().contains("unknown"));
        }
        other => panic!("expected one system note, got {other:?}"),
    }
    let again = ingest_line(
        &mut state,
        r#"{"type":"system","subtype":"error","error":"unknown error"}"#,
        true,
        None,
    );
    assert!(again.events.is_empty());
}

#[test]
fn api_retry_unknown_is_a_retry_note() {
    let mut state = MapState::default();
    let ingest = ingest_line(
        &mut state,
        r#"{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":2000,"error_status":null,"error":"unknown"}"#,
        true,
        None,
    );
    assert!(!ingest.events.iter().any(|event| matches!(event, SessionEventBody::Error { .. })));
    match ingest.events.as_slice() {
        [SessionEventBody::System { text }] => {
            assert!(text.contains("连接中断"));
            assert!(text.contains("正在重试"));
            assert!(!text.contains("报错"));
            assert!(!text.to_ascii_lowercase().contains("unknown"));
        }
        other => panic!("expected one system note, got {other:?}"),
    }
    let again = ingest_line(
        &mut state,
        r#"{"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"error_status":null,"error":"unknown"}"#,
        true,
        None,
    );
    assert!(again.events.is_empty());
    let thinner = ingest_line(
        &mut state,
        r#"{"type":"system","subtype":"error","error":"unknown"}"#,
        true,
        None,
    );
    assert!(thinner.events.is_empty());
}

#[test]
fn api_retry_rate_limit_uses_capacity_copy() {
    let mut state = MapState::default();
    let ingest = ingest_line(
        &mut state,
        r#"{"type":"system","subtype":"api_retry","attempt":1,"max_retries":5,"retry_delay_ms":8000,"error_status":429,"error":"rate_limit"}"#,
        true,
        None,
    );
    match ingest.events.as_slice() {
        [SessionEventBody::System { text }] => {
            assert!(text.contains("请求过于频繁"));
            assert!(text.contains("正在重试"));
            assert!(!text.contains("rate_limit"));
            assert!(!text.contains("报错"));
        }
        other => panic!("expected one system note, got {other:?}"),
    }
}

#[test]
fn connection_payload_keeps_formatted_text() {
    let mut state = MapState::default();
    let ingest = ingest_line(
        &mut state,
        r#"{"type":"system","subtype":"error","error":{"formatted":"unknown","message":"unknown error","connection":{"message":"ECONNRESET"}}}"#,
        true,
        None,
    );
    match ingest.events.as_slice() {
        [SessionEventBody::Error { message }] => {
            assert!(message.contains("ECONNRESET"));
            assert!(!message.to_ascii_lowercase().contains("unknown"));
            assert!(!message.contains("报错"));
        }
        other => panic!("expected the connection text, got {other:?}"),
    }
}

#[test]
fn terminal_is_error_is_a_red_banner() {
    let mut state = MapState::default();
    let live = ingest_line(
        &mut state,
        r#"{"type":"system","subtype":"error","error":"unknown"}"#,
        true,
        None,
    );
    assert!(!live.events.iter().any(|event| matches!(event, SessionEventBody::Error { .. })));
    let done = ingest_line(
        &mut state,
        r#"{"type":"result","subtype":"error_during_execution","is_error":true,"api_error_status":429,"errors":["unknown"]}"#,
        true,
        None,
    );
    assert!(done.events.iter().any(|event| matches!(
        event,
        SessionEventBody::Error { message } if message.contains("请求过于频繁") && !message.contains("报错")
    )));
    assert!(done.events.iter().any(|event| matches!(
        event,
        SessionEventBody::StatusChanged { status: SessionStatus::Completed }
    )));
    let bare = ingest_line(
        &mut MapState::default(),
        r#"{"type":"result","subtype":"error_during_execution","is_error":true}"#,
        true,
        None,
    );
    assert!(bare.events.iter().any(|event| matches!(
        event,
        SessionEventBody::Error { message } if message.contains("报错")
    )));
}

#[test]
fn streaming_abort_keeps_the_session_usable() {
    let mut state = MapState::default();
    let ingest = ingest_line(
        &mut state,
        r#"{"type":"result","subtype":"error_during_execution","terminal_reason":"aborted_streaming","is_error":true}"#,
        true,
        None,
    );
    // 没有按下停止：aborted_streaming 仍是断线。
    assert!(ingest.events.iter().any(|event| matches!(
        event,
        SessionEventBody::Error { message } if message.contains("连接中断")
    )));
    assert!(ingest.events.iter().any(|event| matches!(
        event,
        SessionEventBody::StatusChanged { status: SessionStatus::Completed }
    )));
    assert!(!ingest.events.iter().any(|event| matches!(
        event,
        SessionEventBody::StatusChanged { status: SessionStatus::Stopped | SessionStatus::Failed }
    )));
}

#[test]
fn api_error_message_is_not_the_answer() {
    let lost = "API Error: Connection lost mid-response. The response above may be incomplete.";
    let mut state = MapState::default();
    state.begin_turn("turn-1");
    let prior = ingest_line(
        &mut state,
        &json!({
            "type": "assistant",
            "uuid": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "先看目录。"}]}
        })
        .to_string(),
        true,
        None,
    );
    assert!(prior.events.iter().any(|event| matches!(
        event,
        SessionEventBody::AgentMessage { text, .. } if text == "先看目录。"
    )));

    let err = ingest_line(
        &mut state,
        &json!({
            "type": "assistant",
            "uuid": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "isApiErrorMessage": true,
            "truncatedAfterOutput": true,
            "error": "server_error",
            "message": {
                "role": "assistant",
                "model": "<synthetic>",
                "content": [{"type": "text", "text": lost}]
            }
        })
        .to_string(),
        true,
        None,
    );
    assert!(!err.events.iter().any(|event| matches!(
        event,
        SessionEventBody::AgentMessage { text, .. } if text.contains("Connection lost") || text.contains("API Error")
    )));
    assert!(err.events.iter().any(|event| matches!(
        event,
        SessionEventBody::Error { message } if message == "Claude Code 连接中断"
    )));
    assert!(!err.events.iter().any(|event| matches!(
        event,
        SessionEventBody::Error { message } if message.contains("报错")
    )));

    let done = ingest_line(
        &mut state,
        r#"{"type":"result","subtype":"error_during_execution","is_error":true}"#,
        true,
        None,
    );
    assert!(!done.events.iter().any(|event| matches!(event, SessionEventBody::Error { .. })));
    assert!(!done.events.iter().any(|event| matches!(
        event,
        SessionEventBody::AgentMessage { text, .. } if text.contains("Connection lost")
    )));
    assert!(done.events.iter().any(|event| matches!(
        event,
        SessionEventBody::StatusChanged { status: SessionStatus::Completed }
    )));

    let mut streamed = MapState::default();
    streamed.begin_turn("turn-2");
    let partial = ingest_line(
        &mut streamed,
        &json!({
            "type": "stream_event",
            "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": lost}}
        })
        .to_string(),
        true,
        None,
    );
    let partial_id = agent_stream_id(&partial.events);
    let cleared = ingest_line(
        &mut streamed,
        &json!({
            "type": "assistant",
            "uuid": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "isApiErrorMessage": true,
            "error": "server_error",
            "message": {"role": "assistant", "model": "<synthetic>", "content": [{"type": "text", "text": lost}]}
        })
        .to_string(),
        true,
        None,
    );
    assert!(cleared.events.iter().any(|event| matches!(
        event,
        SessionEventBody::AgentMessage { text, stream_id, .. }
            if text.is_empty() && stream_id.as_deref() == Some(partial_id.as_str())
    )));
    assert!(cleared.events.iter().any(|event| matches!(
        event,
        SessionEventBody::Error { message } if message == "Claude Code 连接中断"
    )));

    let mut only_result = MapState::default();
    let bare = ingest_line(
        &mut only_result,
        &json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "result": lost
        })
        .to_string(),
        true,
        None,
    );
    assert!(!bare.events.iter().any(|event| matches!(
        event,
        SessionEventBody::AgentMessage { text, .. } if text.contains("Connection lost")
    )));
    assert!(bare.events.iter().any(|event| matches!(
        event,
        SessionEventBody::Error { message } if message == "Claude Code 连接中断"
    )));
}

#[test]
fn meta_resume_is_not_a_user_bubble() {
    let resume = "Your response above was cut off mid-stream. Resume directly from where it stops \u{2014} no apology, no recap. If none of it survived, answer the request from the start.";
    let mut live = MapState::default();
    let echoed = ingest_line(
        &mut live,
        &json!({
            "type": "user",
            "uuid": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            "isMeta": true,
            "message": {"role": "user", "content": resume}
        })
        .to_string(),
        true,
        None,
    );
    assert!(echoed.events.is_empty());
    let replay = ingest_line(
        &mut MapState::default(),
        &json!({
            "type": "user",
            "uuid": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            "isMeta": true,
            "message": {"role": "user", "content": [{"type": "text", "text": resume}]}
        })
        .to_string(),
        false,
        None,
    );
    assert!(replay.events.iter().all(|event| !matches!(event, SessionEventBody::UserMessage { .. })));

    let user = "11111111-1111-4111-8111-111111111111";
    let assistant = "22222222-2222-4222-8222-222222222222";
    let meta = "33333333-3333-4333-8333-333333333333";
    let lost_id = "44444444-4444-4444-8444-444444444444";
    let lost = "API Error: Connection lost mid-response. The response above may be incomplete.";
    let transcript = format!(
        "{}\n{}\n{}\n{}\n",
        json!({"type":"user","uuid":user,"parentUuid":null,"message":{"role":"user","content":"做个游戏"}}),
        json!({"type":"assistant","uuid":assistant,"parentUuid":user,"message":{"role":"assistant","content":[{"type":"text","text":"先看目录"}]}}),
        json!({"type":"user","uuid":meta,"parentUuid":assistant,"isMeta":true,"message":{"role":"user","content":resume}}),
        json!({"type":"assistant","uuid":lost_id,"parentUuid":meta,"isApiErrorMessage":true,"truncatedAfterOutput":true,"error":"server_error","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":lost}]}}),
    );
    let mut history = MapState::default();
    let events = messages::events_from_transcript(&mut history, &transcript, None);
    let texts: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::UserMessage { text, .. } => Some(text.as_str()),
            SessionEventBody::AgentMessage { text, .. } if !text.is_empty() => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, vec!["做个游戏", "先看目录"]);
    assert!(events.iter().any(|event| matches!(
        event,
        SessionEventBody::Error { message } if message == "Claude Code 连接中断"
    )));
    assert!(!events.iter().any(|event| match event {
        SessionEventBody::UserMessage { text, .. } | SessionEventBody::AgentMessage { text, .. } => {
            text.contains("cut off mid-stream") || text.contains("Connection lost")
        }
        _ => false,
    }));
}

#[test]
fn prefer_native_binary_over_a_batch_shim() {
    let dir = temp_dir("bin");
    let cmd = dir.join("claude.cmd");
    let exe = dir.join("claude.exe");
    std::fs::write(&cmd, "@echo off\r\n").unwrap();
    std::fs::write(&exe, "").unwrap();
    assert_eq!(process::prefer_native(cmd.clone()).unwrap(), exe);
    std::fs::remove_file(&exe).unwrap();
    assert!(process::prefer_native(cmd).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn edit_input_does_not_need_a_cli_diff_event() {
    let changes = diff::changes_for_tool(
        None,
        "Write",
        &json!({"file_path": "src/new.txt", "content": "hello\n"}),
        None,
    );
    assert_eq!(changes.len(), 1);
    assert!(changes[0].diff.contains("+++ b/src/new.txt"));
    assert!(changes[0].diff.contains("+hello"));
}

#[test]
fn rejected_edit_is_not_a_change() {
    let mut state = MapState::default();
    state.begin_turn("turn-1");
    ingest_line(
        &mut state,
        r#"{"type":"assistant","uuid":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","message":{"role":"assistant","content":[{"type":"tool_use","id":"tool-9","name":"Edit","input":{"file_path":"calc.py","old_string":"a","new_string":"b"}}]}}"#,
        true,
        None,
    );
    let rejected = ingest_line(
        &mut state,
        r#"{"type":"user","uuid":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-9","is_error":true,"content":"The user doesn't want to proceed with this tool use."}]}}"#,
        true,
        None,
    );
    assert!(!rejected.events.iter().any(|event| matches!(
        event,
        SessionEventBody::FileChange { .. } | SessionEventBody::TurnChanges { .. }
    )));
}

#[test]
fn counts_messages_absorbed_into_the_running_turn() {
    let text = [
        r#"{"type":"queue-operation","operation":"enqueue","content":"a"}"#,
        r#"{"type":"queue-operation","operation":"dequeue"}"#,
        r#"{"type":"queue-operation","operation":"enqueue","content":"b"}"#,
        r#"{"type":"queue-operation","operation":"remove","content":"b","reason":"absorbed_mid_turn"}"#,
        r#"{"type":"user","message":{"role":"user","content":"absorbed_mid_turn queue-operation"}}"#,
    ]
    .join("
");
    assert_eq!(super::runtime::count_absorbed(&text), 1);
}

#[test]
fn history_writes_slash_commands_and_absorbed_messages_as_the_user_typed_them() {
    let text = [
        r#"{"type":"user","uuid":"10000000-0000-4000-8000-000000000001","parentUuid":null,"message":{"role":"user","content":"跑一下"}}"#,
        r#"{"type":"attachment","uuid":"10000000-0000-4000-8000-000000000002","parentUuid":"10000000-0000-4000-8000-000000000001","attachment":{"type":"queued_command","prompt":"顺便加上 B"}}"#,
        r#"{"type":"assistant","uuid":"10000000-0000-4000-8000-000000000003","parentUuid":"10000000-0000-4000-8000-000000000002","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"A B"}]}}"#,
        r#"{"type":"user","uuid":"10000000-0000-4000-8000-000000000004","parentUuid":"10000000-0000-4000-8000-000000000003","message":{"role":"user","content":"<command-name>/goal</command-name>\n  <command-message>goal</command-message>\n  <command-args>测试都通过</command-args>"}}"#,
    ]
    .join("
");
    let mut state = MapState::default();
    let users: Vec<String> = messages::events_from_transcript(&mut state, &text, None)
        .into_iter()
        .filter_map(|event| match event {
            SessionEventBody::UserMessage { text, .. } => Some(text),
            _ => None,
        })
        .collect();
    assert_eq!(users, ["跑一下", "顺便加上 B", "/goal 测试都通过"]);
}
