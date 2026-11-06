//! 手动运行：cargo test -p aiwb-agents live_cursor_steering -- --ignored --nocapture
use std::time::Duration;

use crate::{AgentAdapter, SessionContext, UserTurn};
use aiwb_core::models::{SessionEventBody, SessionStatus};
use serde_json::json;

fn turn(text: &str) -> UserTurn {
    UserTurn {
        text: text.into(),
        images: vec![],
        client_id: String::new(),
        annotations: vec![],
    }
}

#[tokio::test]
#[ignore = "calls the installed and authenticated Cursor CLI"]
async fn live_cursor_steering_retains_context_and_serializes_followups() {
    let dir = tempfile::tempdir().unwrap();
    let adapter = super::CursorAgentAdapter::new();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = adapter
        .start_session(
            SessionContext {
                project_path: dir.path().to_string_lossy().into(),
                access_mode: Some("ask".into()),
                resume_native_id: None,
                workbench_mcp: None,
                options: json!({"persist":true}),
            },
            tx,
        )
        .await
        .unwrap();
    let native = handle.native_id().unwrap();
    while rx.try_recv().is_ok() {}
    let catalog = handle.catalog().await.unwrap();
    if catalog.models.iter().any(|m| m.id == "grok-4.7") {
        handle.set_tuning(Some("grok-4.7".into()), None).unwrap();
    }
    let outcome = tokio::time::timeout(Duration::from_secs(180), async {
        handle.deliver(turn("Our fictional project mascot is a silver otter. Remember its color and animal for the next question. Without using any tools, write 200 numbered short suggestions for activities for this mascot, one per line. Start immediately.")).await.unwrap();
        let mut sent = false;
        let mut anchors = 0;
        let mut users = vec![];
        let mut last_answer = String::new();
        loop {
            let event = rx.recv().await.unwrap();
            match event {
                SessionEventBody::TurnAnchor { .. } => anchors += 1,
                SessionEventBody::AgentMessage { text, .. } => {
                    if !sent {
                        eprintln!("First output received; sending two follow-ups");
                        sent = true;
                        handle.deliver_now(turn("Change of direction: our project meeting is on Tuesday. Remember the day. Without tools, give 100 numbered ideas for preparing that meeting.")).await.unwrap();
                        handle.deliver_now(turn("Stop the lists. What animal and color is our project mascot, and on what day is our meeting? Answer in one short sentence using our conversation. Do not use tools.")).await.unwrap();
                    }
                    last_answer = text;
                }
                SessionEventBody::UserMessage { text, .. } => { users.push(text); }
                SessionEventBody::Error { message } => panic!("CLI error: {message}"),
                SessionEventBody::Prompt { .. } => panic!("Unexpected prompt in text-only test"),
                SessionEventBody::StatusChanged { status: SessionStatus::Stopped | SessionStatus::Failed } => panic!("Steering ended the workbench turn"),
                SessionEventBody::StatusChanged { status: SessionStatus::Completed } => {
                    assert!(sent);
                    assert_eq!(users.len(), 2, "{users:?}");
                    assert!(users[0].starts_with("Change of direction"));
                    assert!(users[1].starts_with("Stop the lists"));
                    assert_eq!(anchors, 1);
                    assert_eq!(handle.native_id().as_deref(), Some(native.as_str()));
                    eprintln!("Final answer: {last_answer}");
                    let answer = last_answer.to_lowercase();
                    assert!(answer.contains("silver") && answer.contains("otter") && answer.contains("tuesday"), "context lost: {last_answer}");
                    break;
                }
                _ => {}
            }
        }
    }).await;
    handle.stop().await.unwrap();
    adapter.delete_thread(&native).await.unwrap();
    outcome.expect("live steering timed out");
}

#[tokio::test]
#[ignore = "calls the installed Cursor CLI and a temporary shell command"]
async fn live_cursor_steering_during_tool_execution() {
    use aiwb_core::models::ToolStatus;
    let dir = tempfile::tempdir().unwrap();
    let adapter = super::CursorAgentAdapter::new();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = adapter
        .start_session(
            SessionContext {
                project_path: dir.path().to_string_lossy().into(),
                access_mode: Some("full".into()),
                resume_native_id: None,
                workbench_mcp: None,
                options: json!({"persist":true}),
            },
            tx,
        )
        .await
        .unwrap();
    let native = handle.native_id().unwrap();
    while rx.try_recv().is_ok() {}
    let catalog = handle.catalog().await.unwrap();
    if catalog.models.iter().any(|m| m.id == "grok-4.7") {
        handle.set_tuning(Some("grok-4.7".into()), None).unwrap();
    }
    let outcome = tokio::time::timeout(Duration::from_secs(180), async {
        handle.deliver(turn("Run exactly this shell command: powershell.exe -NoProfile -Command \"Start-Sleep -Seconds 20; Write-Output finished\". Do not run any other commands or change files. Afterwards explain what it did in one sentence.")).await.unwrap();
        let mut sent = false;
        let mut cancelled_tool = false;
        let mut dispatched = false;
        loop {
            match rx.recv().await.unwrap() {
                SessionEventBody::ToolCall { status: ToolStatus::Running, summary, .. }
                    if !sent && summary.contains("Start-Sleep") => {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    sent = true;
                    eprintln!("Steering while shell command is running");
                    handle.deliver_now(turn("Cancel the earlier task and do not run the shell command again. Without tools, explain in one short sentence what a command timeout is.")).await.unwrap();
                }
                SessionEventBody::ToolCall { status: ToolStatus::Failed, .. } if sent => cancelled_tool = true,
                SessionEventBody::UserMessage { .. } => dispatched = true,
                SessionEventBody::StatusChanged { status: SessionStatus::Stopped | SessionStatus::Failed } => panic!("Steering ended the workbench turn"),
                SessionEventBody::Error { message } => panic!("CLI error: {message}"),
                SessionEventBody::StatusChanged { status: SessionStatus::Completed } => {
                    assert!(sent && dispatched && cancelled_tool);
                    assert_eq!(handle.native_id().as_deref(), Some(native.as_str()));
                    break;
                }
                _ => {}
            }
        }
    }).await;
    handle.stop().await.unwrap();
    adapter.delete_thread(&native).await.unwrap();
    outcome.expect("live tool steering timed out");
}
