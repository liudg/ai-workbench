//! 后台任务的夹具。报文从 Claude Code 2.1.326（2026-11-17，haiku）实录里截出来，去掉了无关字段。

use aiwb_core::models::{BackgroundTask, BackgroundTaskStatus, SessionEventBody};
use serde_json::json;

use super::messages::{events_from_transcript, ingest_line, MapState};
use super::runtime::turn_starts;

const STARTED: &str = r#"{"type":"system","subtype":"task_started","task_id":"b5kiw7hh2","run_id":"0mwkl9c6z-8b928bcd","tool_use_id":"toolu_01KQ","description":"Run delayed echo marker in background","is_backgrounded":true,"task_type":"local_bash","session_id":"s"}"#;

fn tasks(events: &[SessionEventBody]) -> Vec<BackgroundTask> {
    events
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::BackgroundTask(task) => Some(task.clone()),
            _ => None,
        })
        .collect()
}

fn live(state: &mut MapState, line: &str) -> Vec<SessionEventBody> {
    ingest_line(state, line, true, None).events
}

/// `local_bash` 起来就是一条在跑的后台任务，挂着启动它的工具调用；`task_updated` 结束，`task_notification` 补摘要和输出文件。
#[test]
fn background_command_runs_until_its_notification() {
    let mut state = MapState::default();
    let started = tasks(&live(&mut state, STARTED));
    assert_eq!(started.len(), 1);
    let task = &started[0];
    assert_eq!((task.task_id.as_str(), task.task_type.as_str()), ("b5kiw7hh2", "local_bash"));
    assert_eq!(task.tool_call_id.as_deref(), Some("toolu_01KQ"));
    assert_eq!(task.title, "Run delayed echo marker in background");
    assert!(task.running());
    assert!(state.subagents.is_empty(), "后台命令不是子 Agent");

    let updated = tasks(&live(
        &mut state,
        r#"{"type":"system","subtype":"task_updated","task_id":"b5kiw7hh2","patch":{"status":"completed","end_time":1794913701108}}"#,
    ));
    assert_eq!(updated[0].status, BackgroundTaskStatus::Completed);
    assert_eq!(updated[0].ended_at, Some(1794913701108));

    let notified = tasks(&live(
        &mut state,
        r#"{"type":"system","subtype":"task_notification","task_id":"b5kiw7hh2","tool_use_id":"toolu_01KQ","status":"completed","output_file":"/tmp/b5kiw7hh2.output","summary":"Background command \"Run delayed echo marker in background\" completed (exit code 0)"}"#,
    ));
    let task = &notified[0];
    assert_eq!(task.status, BackgroundTaskStatus::Completed);
    assert_eq!(task.output_file.as_deref(), Some("/tmp/b5kiw7hh2.output"));
    assert!(task.result.contains("exit code 0"), "{task:?}");
    assert_eq!(task.ended_at, Some(1794913701108), "结束时间以 task_updated 为准");
}

/// `stop_task` 停掉的：`task_updated` 报 `killed`，`task_notification` 报 `stopped`，都是已停止。
#[test]
fn stopped_background_command_is_stopped() {
    let mut state = MapState::default();
    live(&mut state, STARTED);
    let updated = tasks(&live(
        &mut state,
        r#"{"type":"system","subtype":"task_updated","task_id":"b5kiw7hh2","patch":{"status":"killed","end_time":1}}"#,
    ));
    assert_eq!(updated[0].status, BackgroundTaskStatus::Stopped);
    let notified = tasks(&live(
        &mut state,
        r#"{"type":"system","subtype":"task_notification","task_id":"b5kiw7hh2","status":"stopped","summary":"Run delayed echo marker in background"}"#,
    ));
    assert_eq!(notified[0].status, BackgroundTaskStatus::Stopped);
    assert!(!state.background_running("b5kiw7hh2"));
}

/// 子 Agent 自己的前台命令也发 `task_started`，但没放到后台，不算后台任务（Claude Code 2.1.312 实录）。
#[test]
fn foreground_commands_are_not_background_tasks() {
    let mut state = MapState::default();
    let events = live(
        &mut state,
        r#"{"type":"system","subtype":"task_started","task_id":"b6pn","owned_by_subagent":true,"tool_use_id":"toolu_inner","description":"Sleep","is_backgrounded":false,"parent_task_id":"aac6","task_type":"local_bash"}"#,
    );
    assert!(events.is_empty(), "{events:?}");
    assert!(state.background.is_empty());
}

/// 子 Agent 放到后台的命令不登记：子 Agent 结束时 CLI 就把它杀了（Claude Code 2.1.326，2026-11-18 实录）。
#[test]
fn subagent_background_commands_are_not_session_tasks() {
    let mut state = MapState::default();
    for line in [
        r#"{"type":"system","subtype":"task_started","task_id":"bp4yzcv06","task_type":"local_bash","tool_use_id":"toolu_019g","description":"Run sleep 25 then echo marker in background","is_backgrounded":true,"owned_by_subagent":true}"#,
        r#"{"type":"system","subtype":"task_updated","task_id":"bp4yzcv06","patch":{"status":"killed","end_time":1794967194107}}"#,
        r#"{"type":"system","subtype":"task_notification","task_id":"bp4yzcv06","tool_use_id":"toolu_019g","status":"stopped","summary":"Run sleep 25 then echo marker in background"}"#,
    ] {
        let events = live(&mut state, line);
        assert!(events.is_empty(), "{line}: {events:?}");
    }
    assert!(state.background.is_empty());
    assert!(state.subagents.is_empty());
}

/// 子 Agent 的任务仍走子 Agent 卡片，不算后台任务。
#[test]
fn agent_tasks_stay_subagent_cards() {
    let mut state = MapState::default();
    let events = live(
        &mut state,
        r#"{"type":"system","subtype":"task_started","task_id":"a1","tool_use_id":"toolu_A","description":"look","task_type":"local_agent","is_backgrounded":true}"#,
    );
    assert!(tasks(&events).is_empty());
    assert!(events.iter().any(|event| matches!(event, SessionEventBody::Subagent(_))));
}

/// 进程退出时还在跑的后台任务记成已停止。
#[test]
fn exit_stops_running_background_commands() {
    let mut state = MapState::default();
    live(&mut state, STARTED);
    let stopped = tasks(&state.stop_background());
    assert_eq!(stopped.len(), 1);
    assert_eq!(stopped[0].status, BackgroundTaskStatus::Stopped);
    assert!(state.stop_background().is_empty());
}

/// 转录里后台命令结束的那条通知：不画用户气泡，也不当成子 Agent 卡片，读历史时不建任务。
#[test]
fn history_notification_for_a_command_is_silent() {
    let mut state = MapState::default();
    let transcript = concat!(
        r#"{"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":[{"type":"text","text":"run it"}]}}"#,
        "\n",
        r#"{"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"toolu_01KQ","name":"Bash","input":{"command":"sleep 25","run_in_background":true}}]}}"#,
        "\n",
        r#"{"type":"user","uuid":"u2","parentUuid":"a1","message":{"role":"user","content":[{"tool_use_id":"toolu_01KQ","type":"tool_result","content":"Command running in background with ID: b5kiw7hh2.","is_error":false}]},"toolUseResult":{"stdout":"","stderr":"","interrupted":false,"backgroundTaskId":"b5kiw7hh2"}}"#,
        "\n",
        r#"{"type":"user","uuid":"u3","parentUuid":"u2","message":{"role":"user","content":"<task-notification>\n<task-id>b5kiw7hh2</task-id>\n<tool-use-id>toolu_01KQ</tool-use-id>\n<status>completed</status>\n<summary>Background command completed (exit code 0)</summary>\n</task-notification>"},"origin":{"kind":"task-notification"}}"#,
        "\n",
    );
    let events = events_from_transcript(&mut state, transcript, None);
    assert!(!events.iter().any(|event| matches!(event, SessionEventBody::Subagent(_))), "{events:#?}");
    assert!(tasks(&events).is_empty(), "{events:#?}");
    assert!(
        !events.iter().any(|event| matches!(event, SessionEventBody::UserMessage { text, .. } if text.contains("task-notification"))),
        "{events:#?}"
    );
}

#[test]
fn only_system_init_starts_a_turn() {
    assert!(turn_starts(&json!({"type":"system","subtype":"init","cwd":"x","session_id":"s"})));
    assert!(!turn_starts(&json!({"type":"system","subtype":"status","status":"init"})));
    assert!(!turn_starts(&json!({"type":"assistant","message":{"content":[{"type":"text","text":"init"}]}})));
}
