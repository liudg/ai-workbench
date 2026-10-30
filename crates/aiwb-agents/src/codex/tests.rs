use std::time::Duration;

use tokio::time::timeout;

use super::*;
use crate::{TurnDelivery, UserTurn};
use aiwb_core::models::{PromptAnswer, PromptKind, PromptQuestion, ToolStatus};

#[tokio::test]
#[ignore = "calls the local Codex CLI"]
async fn catalog_lists_live_models() {
    let adapter = CodexCliAdapter::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    let session = adapter
        .start_session(
            SessionContext {
                project_path: std::env::temp_dir().to_string_lossy().to_string(),
                access_mode: Some("read-only".into()),
                resume_native_id: None,
                options: serde_json::json!({ "persist": false }),
            },
            tx,
        )
        .await
        .expect("start");
    let catalog = session.catalog().await.expect("catalog");
    assert!(!catalog.models.is_empty(), "codex returned no models");
    assert!(
        catalog.models.iter().any(|model| !model.efforts.is_empty()),
        "codex returned no reasoning efforts"
    );
    let _ = session.stop().await;
}

/// 真实链路：Codex async 提问 → 问题卡片 → 回答 steer 回回合 → 模型确认。
#[tokio::test]
#[ignore = "calls the local Codex CLI"]
async fn async_questions_roundtrip() {
    let adapter = CodexCliAdapter::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let cwd = std::env::temp_dir();
    let session = adapter
        .start_session(
            SessionContext {
                project_path: cwd.to_string_lossy().to_string(),
                access_mode: Some("read-only".into()),
                resume_native_id: None,
                options: serde_json::json!({ "persist": false }),
            },
            tx,
        )
        .await
        .expect("start");
    session
        .send_message(
            "Ask me TWO questions using the async questions mechanism: \
             (1) 'Which framework should I use?' with options Vite, Next.js, Astro. \
             (2) 'Any extra constraints?' with no options. \
             Wait for my reply, then confirm my choices in one short sentence."
                .into(),
        )
        .await
        .expect("send");

    let mut prompt: Option<(String, Vec<PromptQuestion>)> = None;
    let mut resolved: Option<String> = None;
    let mut final_text = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
    while tokio::time::Instant::now() < deadline {
        match timeout(Duration::from_secs(10), rx.recv()).await {
            Ok(Some(SessionEventBody::Prompt {
                prompt_id,
                prompt_kind: PromptKind::Questions,
                questions,
                ..
            })) => {
                assert_eq!(questions.len(), 2, "expected two questions");
                assert_eq!(questions[0].options.len(), 3, "expected three options");
                assert!(questions[1].options.is_empty());
                let mut answers = std::collections::HashMap::new();
                answers.insert(questions[0].id.clone(), "Vite".to_string());
                answers.insert(questions[1].id.clone(), "no extra constraints".to_string());
                session
                    .answer_prompt(
                        &prompt_id,
                        PromptAnswer::Questions {
                            answers,
                            skipped: false,
                        },
                    )
                    .await
                    .expect("answer");
                prompt = Some((prompt_id, questions));
            }
            Ok(Some(SessionEventBody::PromptResolved { answer, .. })) => {
                resolved = Some(answer);
            }
            Ok(Some(SessionEventBody::AgentMessage { text, .. })) => {
                final_text = text;
            }
            Ok(Some(SessionEventBody::StatusChanged {
                status: SessionStatus::Completed,
            })) if prompt.is_some() => break,
            Ok(Some(SessionEventBody::StatusChanged {
                status: SessionStatus::Failed,
            })) => panic!("turn failed, last message: {final_text}"),
            Ok(Some(SessionEventBody::Error { message })) => {
                panic!("codex error: {message}")
            }
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {}
        }
    }
    let _ = session.stop().await;
    assert!(prompt.is_some(), "never received a question card");
    assert_eq!(
        resolved.as_deref(),
        Some("1. Vite\n2. no extra constraints"),
        "resolved summary"
    );
    assert!(
        final_text.to_ascii_lowercase().contains("vite"),
        "model did not acknowledge the answer, last message: {final_text}"
    );
}

/// 跳过一个 async 提问：回合应继续并完成，摘要为「已跳过」。
#[tokio::test]
#[ignore = "calls the local Codex CLI"]
async fn async_questions_skip() {
    let adapter = CodexCliAdapter::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let cwd = std::env::temp_dir();
    let session = adapter
        .start_session(
            SessionContext {
                project_path: cwd.to_string_lossy().to_string(),
                access_mode: Some("read-only".into()),
                resume_native_id: None,
                options: serde_json::json!({ "persist": false }),
            },
            tx,
        )
        .await
        .expect("start");
    session
        .send_message(
            "Ask me ONE question using the async questions mechanism: \
             'Which color should the button be?' with options Red, Blue. \
             If I decline to answer, just pick one yourself and confirm in one short sentence."
                .into(),
        )
        .await
        .expect("send");

    let mut answered = false;
    let mut resolved: Option<String> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
    while tokio::time::Instant::now() < deadline {
        match timeout(Duration::from_secs(10), rx.recv()).await {
            Ok(Some(SessionEventBody::Prompt {
                prompt_id,
                prompt_kind: PromptKind::Questions,
                ..
            })) => {
                session
                    .answer_prompt(
                        &prompt_id,
                        PromptAnswer::Questions {
                            answers: std::collections::HashMap::new(),
                            skipped: true,
                        },
                    )
                    .await
                    .expect("skip");
                answered = true;
            }
            Ok(Some(SessionEventBody::PromptResolved { answer, .. })) => {
                resolved = Some(answer);
            }
            Ok(Some(SessionEventBody::StatusChanged {
                status: SessionStatus::Completed,
            })) if answered => break,
            Ok(Some(SessionEventBody::StatusChanged {
                status: SessionStatus::Failed,
            })) => panic!("turn failed"),
            Ok(Some(SessionEventBody::Error { message })) => {
                panic!("codex error: {message}")
            }
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {}
        }
    }
    let _ = session.stop().await;
    assert!(answered, "never received a question card");
    assert_eq!(resolved.as_deref(), Some("已跳过"), "skip summary");
}

#[tokio::test]
#[ignore = "calls the local Codex CLI"]
async fn smoke_readonly_turn() {
    let adapter = CodexCliAdapter::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let cwd = std::env::temp_dir();
    let session = adapter
        .start_session(
            SessionContext {
                project_path: cwd.to_string_lossy().to_string(),
                access_mode: Some("read-only".into()),
                resume_native_id: None,
                options: serde_json::json!({ "persist": false }),
            },
            tx,
        )
        .await
        .expect("start");
    session
        .send_message("Reply with exactly pong. Do not use tools.".into())
        .await
        .expect("send");

    let mut saw = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    while tokio::time::Instant::now() < deadline {
        match timeout(Duration::from_secs(8), rx.recv()).await {
            Ok(Some(SessionEventBody::AgentMessage { text, .. })) => saw = text,
            Ok(Some(SessionEventBody::StatusChanged {
                status: SessionStatus::Completed,
            })) if saw.to_ascii_lowercase().contains("pong") => {
                let _ = session.stop().await;
                return;
            }
            Ok(Some(SessionEventBody::StatusChanged {
                status: SessionStatus::Failed,
            })) => panic!("turn failed, last message: {saw}"),
            Ok(Some(SessionEventBody::Error { message })) => panic!("codex error: {message}"),
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {}
        }
    }
    let _ = session.stop().await;
    panic!("timed out waiting for pong, last message: {saw}");
}

/// Live check in `_gap-img-queue`: localImage input, then a queued follow-up.
#[tokio::test]
#[ignore = "calls the local Codex CLI in _gap-img-queue"]
async fn gap_image_turn_and_queue() {
    let cwd = r"C:\Users\admin\Desktop\temp\ai-workbench-project\_gap-img-queue";
    let image = format!(r"{cwd}\probe.png");
    assert!(std::path::Path::new(&image).is_file(), "missing {image}");
    delete_gap_threads().await;
    let adapter = CodexCliAdapter::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let session = adapter
        .start_session(
            SessionContext {
                project_path: cwd.into(),
                access_mode: Some("read-only".into()),
                resume_native_id: None,
                options: serde_json::json!({ "persist": true }),
            },
            tx,
        )
        .await
        .expect("start");
    let started = session
        .deliver(UserTurn {
            text: "Count from 1 to 400, one number per line. Do not use tools.".into(),
            images: vec![image.clone()],
            client_id: "direct-1".into(),
            annotations: Vec::new(),
        })
        .await
        .expect("image turn");
    assert_eq!(started, TurnDelivery::Started);
    tokio::time::sleep(Duration::from_millis(800)).await;
    let queued = session
        .deliver(UserTurn {
            text: "queued follow-up".into(),
            images: vec![image],
            client_id: "queued-1".into(),
            annotations: Vec::new(),
        })
        .await
        .expect("queue");
    assert_eq!(queued, TurnDelivery::Queued);

    let queued_id = wait_queue(&mut rx, |items| {
        items
            .iter()
            .find(|item| item.text == "queued follow-up")
            .map(|item| item.id.clone())
    })
    .await
    .expect("queued follow-up");
    session
        .update_queued(
            &queued_id,
            UserTurn {
                text: "edited follow-up".into(),
                images: Vec::new(),
                client_id: String::new(),
                annotations: Vec::new(),
            },
        )
        .await
        .expect("update");
    wait_queue(&mut rx, |items| {
        items
            .iter()
            .any(|item| item.id == queued_id && item.text == "edited follow-up")
            .then_some(())
    })
    .await
    .expect("updated in place");
    session.interrupt().await.expect("interrupt");
    let mut saw_user = false;
    let mut saw_completed = false;
    let mut still_queued = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
    while tokio::time::Instant::now() < deadline {
        match timeout(Duration::from_secs(1), rx.recv()).await {
            Ok(Some(SessionEventBody::UserMessage { text, .. }))
                if text == "edited follow-up" =>
            {
                saw_user = true;
            }
            Ok(Some(SessionEventBody::StatusChanged {
                status: SessionStatus::Completed,
            })) => saw_completed = true,
            Ok(Some(SessionEventBody::QueueChanged { items })) => {
                still_queued = items.iter().any(|item| item.id == queued_id);
                if still_queued {
                    break;
                }
            }
            Ok(Some(_)) => {}
            _ => {}
        }
    }
    assert!(
        still_queued && !saw_user,
        "interrupt must leave the queued follow-up (completed={saw_completed}, user={saw_user}, queued={still_queued})"
    );
    session.remove_queued(&queued_id).await.expect("delete");
    wait_queue(&mut rx, |items| {
        (!items.iter().any(|item| item.id == queued_id)).then_some(())
    })
    .await
    .expect("deleted");
    let _ = session.discard_thread().await;
    let _ = session.stop().await;
    delete_gap_threads().await;
}

async fn delete_gap_threads() {
    let directory = CodexDirectory::new();
    let Ok(threads) = directory.list_threads().await else {
        return;
    };
    for thread in threads {
        if thread.cwd.to_ascii_lowercase().contains("_gap-img-queue") {
            let _ = directory.delete_thread(&thread.native_id).await;
        }
    }
}

async fn wait_queue<T>(
    rx: &mut mpsc::UnboundedReceiver<SessionEventBody>,
    mut found: impl FnMut(&[aiwb_core::models::QueuedTurn]) -> Option<T>,
) -> Option<T> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < deadline {
        match timeout(Duration::from_secs(2), rx.recv()).await {
            Ok(Some(SessionEventBody::QueueChanged { items })) => {
                if let Some(value) = found(&items) {
                    return Some(value);
                }
            }
            Ok(Some(_)) => {}
            _ => {}
        }
    }
    None
}

#[tokio::test]
#[ignore = "calls the local Codex CLI in _gap-review-plan"]
async fn review_plan_diff_in_gap_project() {
    let cwd = r"C:\Users\admin\Desktop\temp\ai-workbench-project\_gap-review-plan";
    let adapter = CodexCliAdapter::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let session = adapter
        .start_session(
            SessionContext {
                project_path: cwd.to_string(),
                access_mode: Some("full".into()),
                resume_native_id: None,
                options: serde_json::json!({ "persist": true }),
            },
            tx,
        )
        .await
        .expect("start");
    let persisted = session.native_id().unwrap_or_default();
    let mut problem = String::new();
    if let Err(err) = session
        .start_review(aiwb_core::models::ReviewStart::Uncommitted)
        .await
    {
        problem = format!("review: {err}");
    }
    let mut saw_review = false;
    let mut review_turn = String::new();
    let review_deadline = tokio::time::Instant::now() + Duration::from_secs(150);
    while problem.is_empty() && tokio::time::Instant::now() < review_deadline {
        match timeout(Duration::from_secs(10), rx.recv()).await {
            Ok(Some(SessionEventBody::TurnAnchor { turn_id, .. })) => review_turn = turn_id,
            Ok(Some(
                SessionEventBody::ReviewFindings { .. } | SessionEventBody::TurnDiff { .. },
            )) => saw_review = true,
            Ok(Some(SessionEventBody::StatusChanged {
                status: SessionStatus::Completed,
            })) if saw_review => break,
            Ok(Some(SessionEventBody::StatusChanged {
                status: SessionStatus::Failed,
            })) => problem = "review failed".into(),
            Ok(Some(SessionEventBody::Error { message })) => {
                problem = format!("codex error: {message}");
            }
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {}
        }
    }
    if problem.is_empty() && !saw_review {
        problem = "review did not emit findings or a turn diff".into();
    }
    if problem.is_empty() && review_turn.is_empty() {
        problem = "review did not emit a turn id".into();
    }

    if problem.is_empty() {
        if let Err(err) = session.set_collaboration_mode("plan") {
            problem = format!("plan mode: {err}");
        }
    }
    if problem.is_empty() {
        if let Err(err) = session
            .send_message("Name two steps for renaming the seed note.".into())
            .await
        {
            problem = format!("plan turn: {err}");
        }
    }
    let mut saw_plan = false;
    let mut plan_turn = String::new();
    let mut last_text = String::new();
    let plan_deadline = tokio::time::Instant::now() + Duration::from_secs(150);
    while problem.is_empty() && tokio::time::Instant::now() < plan_deadline {
        match timeout(Duration::from_secs(10), rx.recv()).await {
            Ok(Some(SessionEventBody::TurnAnchor { turn_id, .. })) => plan_turn = turn_id,
            Ok(Some(
                body @ (SessionEventBody::PlanSteps { .. } | SessionEventBody::PlanText { .. }),
            )) => {
                eprintln!("plan item: {body:?}");
                saw_plan = true;
            }
            Ok(Some(SessionEventBody::AgentMessage { text, .. })) => last_text = text,
            Ok(Some(SessionEventBody::Prompt { .. })) if saw_plan => break,
            Ok(Some(SessionEventBody::StatusChanged {
                status: SessionStatus::Completed,
            })) if saw_plan => break,
            Ok(Some(SessionEventBody::StatusChanged {
                status: SessionStatus::Completed,
            })) => break,
            Ok(Some(SessionEventBody::StatusChanged {
                status: SessionStatus::Failed,
            })) => problem = format!("plan failed: {last_text}"),
            Ok(Some(SessionEventBody::Error { message })) => {
                problem = format!("codex error: {message}");
            }
            Ok(Some(other)) => eprintln!("plan event: {other:?}"),
            Ok(None) => break,
            Err(_) => {}
        }
    }
    let _ = session.stop().await;
    if !persisted.is_empty() {
        super::resume::delete_persisted_thread(&persisted)
            .await
            .expect("delete persisted gap thread");
    }
    if problem.is_empty() && !saw_plan && last_text.trim().is_empty() {
        problem = "plan turn produced neither plan items nor a reply".into();
    }
    if problem.is_empty() && plan_turn.is_empty() {
        problem = "plan turn did not emit a turn id".into();
    }
    if saw_plan {
        eprintln!("plan turn emitted structured plan items");
    } else if problem.is_empty() {
        eprintln!("plan turn finished as assistant text: {last_text}");
    }
    if !problem.is_empty() {
        panic!("{problem}");
    }
}

/// 真实 Codex：命令开始时是进行中，结束时带退出码，非零退出算失败。
#[tokio::test]
#[ignore = "calls the local Codex CLI"]
async fn live_command_status_and_exit_code() {
    let adapter = CodexCliAdapter::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let cwd = std::env::temp_dir();
    let session = adapter
        .start_session(
            SessionContext {
                project_path: cwd.to_string_lossy().to_string(),
                access_mode: Some("full".into()),
                resume_native_id: None,
                options: serde_json::json!({ "persist": false }),
            },
            tx,
        )
        .await
        .expect("start");
    session
        .send_message(
            "Run these two shell commands one after the other, each as its own command: \
             first `Start-Sleep -Seconds 3; Write-Output aiwb-ok`, then `exit 3`. \
             Do not retry. Then reply done."
                .into(),
        )
        .await
        .expect("send");

    let mut calls: Vec<(Option<String>, ToolStatus, Option<i64>, String)> = Vec::new();
    let mut started = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    while tokio::time::Instant::now() < deadline {
        match timeout(Duration::from_secs(8), rx.recv()).await {
            Ok(Some(SessionEventBody::ToolCall {
                stream_id,
                status,
                exit_code,
                summary,
                ..
            })) => calls.push((stream_id, status, exit_code, summary)),
            Ok(Some(SessionEventBody::StatusChanged {
                status: SessionStatus::Running,
            })) => started = true,
            Ok(Some(SessionEventBody::StatusChanged {
                status: SessionStatus::Completed | SessionStatus::Failed,
            })) if started => break,
            Ok(Some(other)) => eprintln!("{other:?}"),
            Ok(None) => break,
            Err(_) => {}
        }
    }
    let _ = session.stop().await;
    eprintln!("{calls:#?}");
    let last_of = |needle: &str| {
        calls
            .iter()
            .rev()
            .find(|(_, _, _, summary)| summary.contains(needle))
            .cloned()
            .unwrap_or_else(|| panic!("no call for {needle}: {calls:?}"))
    };
    let ok = last_of("aiwb-ok");
    assert_eq!(ok.1, ToolStatus::Completed);
    assert_eq!(ok.2, Some(0));
    assert!(
        calls.iter().any(|call| call.0 == ok.0 && call.1 == ToolStatus::Running),
        "the sleeping command never showed as running"
    );
    let bad = last_of("exit 3");
    assert_eq!(bad.1, ToolStatus::Failed);
    assert_eq!(bad.2, Some(3));
    assert!(!ok.3.contains('→'), "summary still carries the status: {}", ok.3);
}

/// 真实链路：回复正在流出时连着引导几次，回合要照常结束，引导的话都进时间线。
#[tokio::test]
#[ignore = "calls the local Codex CLI"]
async fn rapid_steers_finish_the_turn() {
    let adapter = CodexCliAdapter::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let session = adapter
        .start_session(
            SessionContext {
                project_path: std::env::temp_dir().to_string_lossy().to_string(),
                access_mode: Some("read-only".into()),
                resume_native_id: None,
                options: serde_json::json!({ "persist": false }),
            },
            tx,
        )
        .await
        .expect("start");
    session
        .deliver(UserTurn {
            text: "不要用任何工具。用中文写一段大约 300 字的关于秋天的散文。".into(),
            images: Vec::new(),
            client_id: "rapid-0".into(),
            annotations: Vec::new(),
        })
        .await
        .expect("first turn");
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    let mut steered = 0;
    let mut finished = false;
    let mut log = Vec::new();
    while std::time::Instant::now() < deadline {
        let Ok(Some(body)) = timeout(Duration::from_millis(500), rx.recv()).await else {
            continue;
        };
        let streaming = matches!(&body, SessionEventBody::AgentMessage { text, .. } if !text.is_empty());
        log.push(format!("{body:?}").chars().take(120).collect::<String>());
        if let SessionEventBody::Error { message } = &body {
            panic!("codex turn failed: {message}");
        }
        if streaming && steered == 0 {
            for index in 1..=4 {
                let delivery = session
                    .deliver_now(UserTurn {
                        text: format!("补充{index}：结尾加一句「收到 {index}」。"),
                        images: Vec::new(),
                        client_id: format!("rapid-{index}"),
                        annotations: Vec::new(),
                    })
                    .await;
                eprintln!("steer {index}: {delivery:?}");
                steered += 1;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        if steered > 0
            && matches!(body, SessionEventBody::StatusChanged { status: aiwb_core::models::SessionStatus::Completed })
        {
            finished = true;
            break;
        }
    }
    let _ = session.stop().await;
    for line in &log {
        eprintln!("{line}");
    }
    assert_eq!(steered, 4);
    assert!(finished, "turn never completed after steering");
}

/// 真实链路：命令还在跑时连着引导几次，回合要照常结束。
#[tokio::test]
#[ignore = "calls the local Codex CLI"]
async fn steering_during_a_command_finishes_the_turn() {
    let adapter = CodexCliAdapter::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let session = adapter
        .start_session(
            SessionContext {
                project_path: std::env::temp_dir().to_string_lossy().to_string(),
                access_mode: Some("read-only".into()),
                resume_native_id: None,
                options: serde_json::json!({ "persist": false }),
            },
            tx,
        )
        .await
        .expect("start");
    session
        .deliver(UserTurn {
            text: "先运行命令 `ping -n 12 127.0.0.1`，等它结束后用一句话告诉我丢包率。".into(),
            images: Vec::new(),
            client_id: "rapid-0".into(),
            annotations: Vec::new(),
        })
        .await
        .expect("first turn");
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    let mut steered = 0;
    let mut finished = false;
    let mut log = Vec::new();
    while std::time::Instant::now() < deadline {
        let Ok(Some(body)) = timeout(Duration::from_millis(500), rx.recv()).await else {
            continue;
        };
        let streaming = matches!(&body, SessionEventBody::ToolCall { .. });
        log.push(format!("{body:?}").chars().take(120).collect::<String>());
        if let SessionEventBody::Error { message } = &body {
            panic!("codex turn failed: {message}");
        }
        if streaming && steered == 0 {
            for index in 1..=4 {
                let delivery = session
                    .deliver_now(UserTurn {
                        text: format!("补充{index}：结尾加一句「收到 {index}」。"),
                        images: Vec::new(),
                        client_id: format!("command-{index}"),
                        annotations: Vec::new(),
                    })
                    .await;
                eprintln!("steer {index}: {delivery:?}");
                steered += 1;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        if steered > 0
            && matches!(body, SessionEventBody::StatusChanged { status: aiwb_core::models::SessionStatus::Completed })
        {
            finished = true;
            break;
        }
    }
    let _ = session.stop().await;
    for line in &log {
        eprintln!("{line}");
    }
    assert_eq!(steered, 4);
    assert!(finished, "turn never completed after steering");
}

/// 真实链路：回复流出时排了几条，再逐条点引导，回合要照常结束。
#[tokio::test]
#[ignore = "calls the local Codex CLI"]
async fn steering_queued_rows_finishes_the_turn() {
    let adapter = CodexCliAdapter::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let session = adapter
        .start_session(
            SessionContext {
                project_path: std::env::temp_dir().to_string_lossy().to_string(),
                access_mode: Some("read-only".into()),
                resume_native_id: None,
                options: serde_json::json!({ "persist": true }),
            },
            tx,
        )
        .await
        .expect("start");
    session
        .deliver(UserTurn {
            text: "不要用任何工具。用中文写一段大约 300 字的关于秋天的散文。".into(),
            images: Vec::new(),
            client_id: "rapid-0".into(),
            annotations: Vec::new(),
        })
        .await
        .expect("first turn");
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    let mut steered = 0;
    let mut finished = false;
    let mut log = Vec::new();
    while std::time::Instant::now() < deadline {
        let Ok(Some(body)) = timeout(Duration::from_millis(500), rx.recv()).await else {
            continue;
        };
        let streaming = matches!(&body, SessionEventBody::AgentMessage { text, .. } if !text.is_empty());
        log.push(format!("{body:?}").chars().take(120).collect::<String>());
        if let SessionEventBody::Error { message } = &body {
            panic!("codex turn failed: {message}");
        }
        if streaming && steered == 0 {
            for index in 1..=4 {
                let delivery = session
                    .deliver(UserTurn {
                        text: format!("补充{index}：结尾加一句「收到 {index}」。"),
                        images: Vec::new(),
                        client_id: format!("queued-{index}"),
                        annotations: Vec::new(),
                    })
                    .await;
                eprintln!("queue {index}: {delivery:?}");
            }
            let mut rows = Vec::new();
            let wait = std::time::Instant::now() + Duration::from_secs(10);
            while rows.len() < 4 && std::time::Instant::now() < wait {
                if let Ok(Some(SessionEventBody::QueueChanged { items })) =
                    timeout(Duration::from_millis(200), rx.recv()).await
                {
                    rows = items;
                }
            }
            eprintln!("queued rows: {}", rows.len());
            let steers = rows.iter().map(|row| {
                let session = session.clone();
                let id = row.id.clone();
                tokio::spawn(async move { (id.clone(), session.steer_queued(&id).await) })
            });
            for steer in steers.collect::<Vec<_>>() {
                let (id, result) = steer.await.expect("steer task");
                eprintln!("steer {id}: {result:?}");
                steered += 1;
            }
        }
        if steered > 0
            && matches!(body, SessionEventBody::StatusChanged { status: aiwb_core::models::SessionStatus::Completed })
        {
            finished = true;
            break;
        }
    }
    let native = session.native_id();
    let _ = session.stop().await;
    if let Some(id) = native {
        let _ = CodexCliAdapter::new().delete_thread(&id).await;
    }
    for line in &log {
        eprintln!("{line}");
    }
    assert_eq!(steered, 4);
    assert!(finished, "turn never completed after steering");
}
