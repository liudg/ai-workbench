//! 手动运行，要本机已登录的 agy：
//! cargo test -p aiwb-agents antigravity::live_tests -- --ignored --nocapture --test-threads=4

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use super::{directory, AntigravityAdapter};
use crate::{AgentAdapter, AgentSession, SessionContext, TurnDelivery, UserTurn, WorkbenchMcp};
use aiwb_core::models::{
    FileStatus, McpAddSpec, McpPair, PromptAnswer, PromptKind, SessionEventBody, SessionStatus, SubagentStatus, ToolStatus,
};

const MODEL: &str = "gemini-4-argon";
const TURN: Duration = Duration::from_secs(240);

fn turn(text: &str) -> UserTurn {
    UserTurn { text: text.into(), images: vec![], client_id: String::new(), annotations: vec![] }
}

struct Live {
    handle: Arc<dyn AgentSession>,
    rx: mpsc::UnboundedReceiver<SessionEventBody>,
    seen: Vec<SessionEventBody>,
    dir: tempfile::TempDir,
}

impl Live {
    async fn open(access: &str, options: Value, mcp: Option<WorkbenchMcp>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha\nbeta\n").unwrap();
        Self::open_in(dir, access, options, mcp, None).await
    }

    async fn open_in(dir: tempfile::TempDir, access: &str, options: Value, mcp: Option<WorkbenchMcp>, resume: Option<String>) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let handle = AntigravityAdapter::new()
            .start_session(
                SessionContext {
                    project_path: dir.path().to_string_lossy().to_string(),
                    access_mode: Some(access.into()),
                    resume_native_id: resume,
                    workbench_mcp: mcp,
                    options,
                },
                tx,
            )
            .await
            .unwrap();
        handle.set_tuning(Some(MODEL.into()), Some("low".into())).unwrap();
        let mut live = Self { handle, rx, seen: Vec::new(), dir };
        live.drain();
        live
    }

    fn drain(&mut self) {
        while let Ok(event) = self.rx.try_recv() {
            self.seen.push(event);
        }
    }

    async fn next(&mut self) -> SessionEventBody {
        let event = tokio::time::timeout(TURN, self.rx.recv()).await.expect("等事件超时").expect("通道关了");
        self.seen.push(event.clone());
        event
    }

    /// 从现在起等到某个条件，返回这段时间收到的事件。
    async fn until(&mut self, done: impl Fn(&SessionEventBody) -> bool) -> Vec<SessionEventBody> {
        let mut got = Vec::new();
        loop {
            let event = self.next().await;
            let hit = done(&event);
            got.push(event);
            if hit {
                return got;
            }
        }
    }

    async fn finished(&mut self) -> (SessionStatus, Vec<SessionEventBody>) {
        let got = self
            .until(|event| {
                matches!(event, SessionEventBody::StatusChanged { status } if matches!(status, SessionStatus::Completed | SessionStatus::Failed | SessionStatus::Stopped))
            })
            .await;
        let status = match got.last() {
            Some(SessionEventBody::StatusChanged { status }) => *status,
            _ => unreachable!(),
        };
        (status, got)
    }

    async fn run(&mut self, text: &str) -> Vec<SessionEventBody> {
        assert!(matches!(self.handle.deliver(turn(text)).await.unwrap(), TurnDelivery::Started));
        let (status, got) = self.finished().await;
        assert_eq!(status, SessionStatus::Completed, "{got:#?}");
        got
    }

    async fn prompt(&mut self) -> (String, PromptKind, Vec<String>, Vec<SessionEventBody>) {
        let got = self.until(|event| matches!(event, SessionEventBody::Prompt { .. })).await;
        let Some(SessionEventBody::Prompt { prompt_id, prompt_kind, options, .. }) = got.last() else { unreachable!() };
        (prompt_id.clone(), *prompt_kind, options.iter().map(|option| option.id.clone()).collect(), got.clone())
    }

    fn native(&self) -> String {
        self.handle.native_id().expect("会话 id")
    }

    async fn close(self) {
        let id = self.native();
        let _ = self.handle.stop().await;
        let _ = directory::remove(&id);
    }
}

fn message(events: &[SessionEventBody]) -> String {
    events
        .iter()
        .rev()
        .find_map(|event| match event {
            SessionEventBody::AgentMessage { text, .. } => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

fn single(value: &str) -> PromptAnswer {
    PromptAnswer::Single { value: value.into() }
}

fn persist() -> Value {
    json!({ "persist": true })
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_turn_runs_tools_and_records_changes() {
    let mut live = Live::open("full", persist(), None).await;
    let catalog = live.handle.catalog().await.unwrap();
    assert!(catalog.models.iter().any(|model| model.id == MODEL && model.efforts.len() == 3), "{:?}", catalog.models);
    assert!(catalog.commands.iter().any(|command| command.name == "/goal"), "{:?}", catalog.commands);
    let got = live
        .run("Do these steps with your tools, in order, no others: 1) run the shell command `echo tool-ok`; 2) in a.txt replace beta with BETA; 3) create b.txt containing the line created; then reply DONE.")
        .await;
    let catalog = live.handle.catalog().await.unwrap();
    assert_eq!(catalog.thread_model.as_deref(), Some(MODEL));
    assert_eq!(catalog.thread_effort.as_deref(), Some("low"));
    assert!(got.iter().any(|event| matches!(event, SessionEventBody::ToolCall { name, status: ToolStatus::Completed, detail, exit_code: Some(0), .. } if name == "command" && detail.contains("tool-ok"))), "{got:#?}");
    assert!(got.iter().any(|event| matches!(event, SessionEventBody::FileChange { path, status: FileStatus::Modified, added: 1, removed: 1, .. } if path == "a.txt")), "{got:#?}");
    assert!(got.iter().any(|event| matches!(event, SessionEventBody::FileChange { path, status: FileStatus::Added, .. } if path == "b.txt")), "{got:#?}");
    assert!(got.iter().any(|event| matches!(event, SessionEventBody::SessionUsage { input_tokens: Some(_), output_tokens: Some(_), .. })), "{got:#?}");
    assert!(got.iter().any(|event| matches!(event, SessionEventBody::TurnChanges { files, .. } if files.len() == 2)), "{got:#?}");
    let diff = live.handle.last_turn_diff().await.unwrap();
    assert!(diff.contains("+BETA") && diff.contains("+created"), "{diff}");
    assert!(message(&got).contains("DONE"));
    assert!(!got.iter().any(|event| matches!(event, SessionEventBody::UserMessage { .. })), "实时回显不该变成用户气泡：{got:#?}");
    live.close().await;
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_commands_ask_and_can_be_denied() {
    let mut live = Live::open("ask", persist(), None).await;
    live.handle
        .deliver(turn("Run the shell command `echo first-ok`. After it finishes run the shell command `echo second-ok`. Run nothing else. Then say what happened to each."))
        .await
        .unwrap();
    let (id, kind, options, _) = live.prompt().await;
    assert_eq!(kind, PromptKind::Approval);
    assert_eq!(options, ["allow", "deny"]);
    live.handle.answer_prompt(&id, single("allow")).await.unwrap();
    let (id, _, _, between) = live.prompt().await;
    assert!(between.iter().any(|event| matches!(event, SessionEventBody::ToolCall { detail, .. } if detail.contains("first-ok"))), "{between:#?}");
    live.handle.answer_prompt(&id, single("deny")).await.unwrap();
    let (status, got) = live.finished().await;
    assert_eq!(status, SessionStatus::Completed);
    assert!(got.iter().any(|event| matches!(event, SessionEventBody::PromptResolved { answer, .. } if answer == "拒绝")) || live.seen.iter().any(|event| matches!(event, SessionEventBody::PromptResolved { answer, .. } if answer == "拒绝")));
    assert!(got.iter().any(|event| matches!(event, SessionEventBody::ToolCall { status: ToolStatus::Failed, .. })), "{got:#?}");
    live.close().await;
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_questions_answer_and_skip() {
    let mut live = Live::open("full", persist(), None).await;
    live.handle
        .deliver(turn("Call the ask_question tool exactly once with one multi-select question 'Pick fruits' with options Apple, Pear, Kiwi. Then repeat my selected options back to me. Use no other tools."))
        .await
        .unwrap();
    let got = live.until(|event| matches!(event, SessionEventBody::Prompt { .. })).await;
    let Some(SessionEventBody::Prompt { prompt_id, prompt_kind, questions, .. }) = got.last().cloned() else { unreachable!() };
    assert_eq!(prompt_kind, PromptKind::Questions);
    assert!(questions[0].multi_select, "{questions:?}");
    assert!(!got.iter().any(|event| matches!(event, SessionEventBody::ToolCall { name, .. } if name.contains("ask_question"))), "{got:#?}");
    let answer = PromptAnswer::Questions {
        answers: [(questions[0].id.clone(), "Apple, Kiwi".to_string())].into_iter().collect(),
        skipped: false,
    };
    live.handle.answer_prompt(&prompt_id, answer).await.unwrap();
    let (status, got) = live.finished().await;
    assert_eq!(status, SessionStatus::Completed);
    let reply = message(&got);
    assert!(reply.contains("Apple") && reply.contains("Kiwi"), "{reply}");

    live.handle
        .deliver(turn("Call the ask_question tool exactly once asking 'Pick size' with options S and M. If I skip it, say SKIPPED. Use no other tools."))
        .await
        .unwrap();
    let got = live.until(|event| matches!(event, SessionEventBody::Prompt { .. })).await;
    let Some(SessionEventBody::Prompt { prompt_id, .. }) = got.last().cloned() else { unreachable!() };
    live.handle
        .answer_prompt(&prompt_id, PromptAnswer::Questions { answers: Default::default(), skipped: true })
        .await
        .unwrap();
    let (status, got) = live.finished().await;
    assert_eq!(status, SessionStatus::Completed, "{got:#?}");
    assert!(message(&got).to_uppercase().contains("SKIP"), "{}", message(&got));
    live.close().await;
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_plan_offers_implementation_and_builds_it() {
    let mut live = Live::open("full", persist(), None).await;
    live.handle.set_collaboration_mode("plan").unwrap();
    live.handle
        .deliver(turn("Plan how to add NOTES.md containing the single line planned. Keep it minimal and stay inside this folder. Write the plan the way plan mode normally does, and do not create NOTES.md yet."))
        .await
        .unwrap();
    let (status, got) = live.finished().await;
    assert_eq!(status, SessionStatus::Completed, "{got:#?}");
    assert!(got.iter().any(|event| matches!(event, SessionEventBody::PlanText { text, mode, .. } if !text.is_empty() && mode.as_deref() == Some("plan"))), "{got:#?}");
    assert!(!got.iter().any(|event| matches!(event, SessionEventBody::FileChange { path, .. } if path.contains("implementation_plan"))), "{got:#?}");
    assert!(!live.dir.path().join("NOTES.md").exists());
    let (id, kind, options, _) = live.prompt().await;
    assert_eq!(kind, PromptKind::Choice);
    assert!(id.starts_with("implement-plan-"));
    assert_eq!(options, ["implement", "clear-context", "stay"]);
    live.handle.answer_prompt(&id, single("implement")).await.unwrap();
    let got = live.until(|event| matches!(event, SessionEventBody::CollaborationMode { mode } if mode == "default")).await;
    assert!(!got.is_empty());
    let (status, got) = live.finished().await;
    // 第一个完成状态可能是开跑前的，真正收尾看文件。
    let mut status = status;
    while status != SessionStatus::Completed || !live.dir.path().join("NOTES.md").exists() {
        let (next, _) = live.finished().await;
        status = next;
    }
    assert!(std::fs::read_to_string(live.dir.path().join("NOTES.md")).unwrap().contains("planned"), "{got:#?}");
    live.close().await;
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_queue_steer_and_cancel() {
    let mut live = Live::open("full", persist(), None).await;
    let slow = "Run this PowerShell command with your terminal tool and wait for it: Start-Sleep -Seconds 12; echo slow-done . Then report its output.";
    assert!(matches!(live.handle.deliver(turn(slow)).await.unwrap(), TurnDelivery::Started));
    live.until(|event| matches!(event, SessionEventBody::ToolCall { name, .. } if name == "command")).await;

    // 排队：可以改、可以删，改过的在回合结束后发出。
    assert!(matches!(live.handle.deliver(turn("Say QUEUED-ONE.")).await.unwrap(), TurnDelivery::Queued));
    assert!(matches!(live.handle.deliver(turn("Say QUEUED-TWO.")).await.unwrap(), TurnDelivery::Queued));
    let got = live
        .until(|event| matches!(event, SessionEventBody::QueueChanged { items } if items.len() == 2))
        .await;
    let Some(SessionEventBody::QueueChanged { items }) = got.last().cloned() else { unreachable!() };
    live.handle.remove_queued(&items[1].id).await.unwrap();
    live.handle.update_queued(&items[0].id, turn("Say exactly the word QUEUED-EDITED and nothing else.")).await.unwrap();

    // 引导：不打断，当前回合里读到新的话，同一回合内完成。
    assert!(matches!(live.handle.deliver_now(turn("Additional instruction: also include the word KIWI in your report.")).await.unwrap(), TurnDelivery::Queued));
    let (status, got) = live.finished().await;
    assert_eq!(status, SessionStatus::Completed, "{got:#?}");
    assert!(got.iter().any(|event| matches!(event, SessionEventBody::AgentMessage { text, .. } if text.contains("KIWI"))), "{got:#?}");
    assert!(got.iter().any(|event| matches!(event, SessionEventBody::UserMessage { text, .. } if text.contains("KIWI"))), "引导要有用户气泡：{got:#?}");

    // 排队的消息在同一次运行里接着发，中间不算结束。改过的发出去，删掉的不发。
    assert!(message(&got).contains("QUEUED-EDITED"), "{got:#?}");
    assert!(!got.iter().any(|event| matches!(event, SessionEventBody::UserMessage { text, .. } if text.contains("QUEUED-TWO"))), "{got:#?}");

    // 停止：回合以 Stopped 结束，会话还能接着用。
    assert!(matches!(live.handle.deliver(turn(slow)).await.unwrap(), TurnDelivery::Started));
    live.until(|event| matches!(event, SessionEventBody::ToolCall { name, .. } if name == "command")).await;
    live.handle.interrupt().await.unwrap();
    let (status, _) = live.finished().await;
    assert_eq!(status, SessionStatus::Stopped);
    let got = live.run("Reply with the single word MANGO.").await;
    assert!(message(&got).contains("MANGO"));
    live.close().await;
}

/// 不动本机登录：改用「应用默认凭据」登录方式，再把凭据和数据目录指到空的临时目录，agy 就是未登录状态。
/// 环境变量对整个测试进程生效，单独跑：
/// cargo test -p aiwb-agents antigravity::live_tests::live_signed_out -- --ignored --test-threads=1
#[tokio::test]
#[ignore = "calls the installed agy with an isolated, signed-out environment"]
async fn live_signed_out_sessions_say_how_to_sign_in() {
    let empty = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let vars = [
        ("AGY_ADC_AUTH", "1".to_string()),
        ("GOOGLE_APPLICATION_CREDENTIALS", empty.path().join("missing.json").to_string_lossy().to_string()),
        ("CLOUDSDK_CONFIG", empty.path().to_string_lossy().to_string()),
        ("APPDATA", empty.path().to_string_lossy().to_string()),
        ("ANTIGRAVITY_GEMINI_DIR", empty.path().join("gemini").to_string_lossy().to_string()),
    ];
    for (key, value) in &vars {
        std::env::set_var(key, value);
    }
    let (tx, _rx) = mpsc::unbounded_channel();
    let opened = AntigravityAdapter::new()
        .start_session(
            SessionContext {
                project_path: project.path().to_string_lossy().to_string(),
                access_mode: Some("full".into()),
                resume_native_id: None,
                workbench_mcp: None,
                options: persist(),
            },
            tx,
        )
        .await;
    for (key, _) in &vars {
        std::env::remove_var(key);
    }
    let message = opened.err().expect("未登录不能打开会话").to_string();
    // 前缀「agent 运行时错误: 」是所有 Agent 共用的错误格式。
    assert!(message.ends_with("Antigravity 还没有登录。请在终端运行 `agy` 登录后再试。"), "{message}");
}

/// 收事件直到回合结束。
async fn settle(rx: &mut mpsc::UnboundedReceiver<SessionEventBody>) -> Vec<SessionEventBody> {
    let mut got = Vec::new();
    while let Ok(Some(event)) = tokio::time::timeout(TURN, rx.recv()).await {
        let done = matches!(event, SessionEventBody::StatusChanged { status: SessionStatus::Completed | SessionStatus::Failed | SessionStatus::Stopped });
        got.push(event);
        if done {
            break;
        }
    }
    got
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_permission_presets_switch_native_modes() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let shared = super::open::open(
        super::open::Open {
            project_path: dir.path().to_string_lossy().to_string(),
            access_mode: Some("ask".into()),
            resume: None,
            persist: true,
            replay_history: true,
            workbench_mcp: None,
            roots: Vec::new(),
            saved_goal: None,
        },
        tx,
    )
    .await
    .unwrap();
    let session = crate::acp::session::AcpSession::new(shared.clone());
    assert_eq!(shared.applied_mode(), "default");
    session.set_tuning(Some(MODEL.into()), Some("low".into())).unwrap();
    let run = |text: &'static str| {
        let session = &session;
        async move { session.deliver(turn(text)).await.unwrap() }
    };
    while rx.try_recv().is_ok() {}
    session.set_access_mode("approve-for-me").unwrap();
    run("Reply with the single word ONE.").await;
    let got = settle(&mut rx).await;
    assert!(!got.iter().any(|event| matches!(event, SessionEventBody::Error { .. })), "{got:#?}");
    assert_eq!(shared.applied_mode(), "accept-edits");
    session.set_access_mode("ask").unwrap();
    run("Reply with the single word TWO.").await;
    let got = settle(&mut rx).await;
    assert!(!got.iter().any(|event| matches!(event, SessionEventBody::Error { .. })), "{got:#?}");
    assert_eq!(shared.applied_mode(), "default");
    let id = shared.session_id().unwrap();
    session.stop().await.unwrap();
    let _ = directory::remove(&id);
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_background_commands_finish_in_the_same_turn() {
    let mut live = Live::open("full", persist(), None).await;
    let got = live
        .run("Run this PowerShell command with your terminal tool and wait for it: Start-Sleep -Seconds 100; echo slow-done . Then report its output in one sentence.")
        .await;
    assert!(got.iter().any(|event| matches!(event, SessionEventBody::ToolCall { name, status: ToolStatus::Completed, detail, .. } if name == "command" && detail.contains("slow-done"))), "{got:#?}");
    let answers: Vec<String> = got
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::AgentMessage { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert!(answers.iter().any(|text| text.contains("slow-done")), "结果要在同一回合里显示：{answers:?}");
    let got = live.run("Reply with the single word NEXT-OK.").await;
    let answers: Vec<String> = got
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::AgentMessage { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert!(answers.iter().any(|text| text.contains("NEXT-OK")), "{answers:?}");
    assert!(!answers.iter().any(|text| text.contains("slow-done")), "已显示的回答不能再出现：{answers:?}");
    live.close().await;
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_resume_replay_import_and_delete() {
    let mut live = Live::open("full", persist(), None).await;
    let id = live.native();
    live.run("Remember the code word PAPAYA-77. Using your terminal tool run `echo remembered`. Reply OK.").await;
    let Live { handle, dir, .. } = live;
    handle.stop().await.unwrap();
    let cwd = dir.path().to_string_lossy().to_string();

    let (tx, _rx) = mpsc::unbounded_channel();
    let adapter = AntigravityAdapter::new();
    let resumed = adapter
        .start_session(
            SessionContext {
                project_path: cwd.clone(),
                access_mode: Some("full".into()),
                resume_native_id: Some(id.clone()),
                workbench_mcp: None,
                options: json!({"persist":true,"skip_history":true}),
            },
            tx,
        )
        .await
        .unwrap();
    assert_eq!(resumed.native_id().as_deref(), Some(id.as_str()));
    resumed.stop().await.unwrap();

    let mut again = Live::open_in(dir, "full", json!({"persist":true,"skip_history":true}), None, Some(id.clone())).await;
    let seen_replay = again.seen.iter().any(|event| matches!(event, SessionEventBody::UserMessage { .. }));
    assert!(!seen_replay, "跳过回放时不该有历史：{:?}", again.seen);
    let got = again.run("What was the code word? Reply with only the word.").await;
    assert!(message(&got).contains("PAPAYA-77"), "{}", message(&got));
    let Live { handle, dir, .. } = again;
    handle.stop().await.unwrap();

    let page = adapter.import_page(&cwd, None, 50).await.unwrap();
    assert!(page.entries.iter().any(|entry| entry.native_id == id), "{page:?}");
    let history = adapter.import_history(&id, &cwd).await.unwrap();
    assert!(history.iter().any(|event| matches!(event, SessionEventBody::UserMessage { text, .. } if text.contains("PAPAYA-77"))), "{history:#?}");
    assert!(history.iter().any(|event| matches!(event, SessionEventBody::ToolCall { detail, .. } if detail.contains("remembered"))), "{history:#?}");
    assert!(history.iter().any(|event| matches!(event, SessionEventBody::AgentMessage { .. })), "{history:#?}");

    adapter.delete_thread(&id).await.unwrap();
    let page = adapter.import_page(&cwd, None, 50).await.unwrap();
    assert!(!page.entries.iter().any(|entry| entry.native_id == id));

    // 删掉之后再接回，要说会话没了，而不是协议原文。
    let (tx, _rx) = mpsc::unbounded_channel();
    let reopened = adapter
        .start_session(
            SessionContext {
                project_path: cwd,
                access_mode: Some("full".into()),
                resume_native_id: Some(id),
                workbench_mcp: None,
                options: json!({"persist":true,"skip_history":true}),
            },
            tx,
        )
        .await;
    assert!(matches!(reopened.err(), Some(crate::AgentError::SessionGone)));
    drop(dir);
}

/// 没发过消息的会话关掉再打开，不能当成被删了。
#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_unsent_session_is_not_gone() {
    let live = Live::open("full", persist(), None).await;
    let id = live.native();
    let Live { handle, dir, .. } = live;
    handle.stop().await.unwrap();
    assert!(!directory::is_gone(&id), "没发消息的会话也要留下文件");
    let again = Live::open_in(dir, "full", json!({"persist":true,"skip_history":true}), None, Some(id.clone())).await;
    assert_eq!(again.native(), id);
    again.close().await;
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_subagents_show_their_steps() {
    let mut live = Live::open("full", persist(), None).await;
    let got = live
        .run("Call the invoke_subagent tool once to start exactly one subagent (TypeName research, Role File Reader) that reads a.txt and reports its first line. Wait for it to finish, then tell me what it reported, prefixed with RESULT:.")
        .await;
    assert!(message(&got).contains("alpha"), "{}", message(&got));
    let segments: std::collections::HashSet<_> = got
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::AgentMessage { stream_id, .. } => stream_id.clone(),
            _ => None,
        })
        .collect();
    let last = got.iter().rev().find_map(|event| match event {
        SessionEventBody::AgentMessage { text, .. } => Some(text.clone()),
        _ => None,
    });
    assert!(segments.len() >= 2 && last.as_deref().is_some_and(|text| text.trim_start().starts_with("RESULT")), "派出后的那句和结果要分成两段：{got:#?}");
    tokio::time::timeout(TURN, async {
        while !live
            .seen
            .iter()
            .any(|event| matches!(event, SessionEventBody::Subagent(card) if card.status == SubagentStatus::Completed && !card.result.is_empty()))
        {
            live.next().await;
        }
    })
    .await
    .expect("子 Agent 没有收尾");
    assert!(live.seen.iter().any(|event| matches!(event, SessionEventBody::Subagent(card) if card.status == SubagentStatus::Running && !card.prompt.is_empty())), "{:#?}", live.seen);
    assert!(live.seen.iter().any(|event| matches!(event, SessionEventBody::SubagentStep { step, .. } if matches!(step.as_ref(), SessionEventBody::ToolCall { name, .. } if name == "Read"))), "{:#?}", live.seen);
    // 已经从转录接上的回答，下一条消息开始时 ACP 还会再推一遍，不能显示两次。
    let got = live.run("Reply with the single word NEXT-OK.").await;
    let answers: Vec<&str> = got
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::AgentMessage { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert!(answers.iter().any(|text| text.contains("NEXT-OK")), "{answers:?}");
    assert!(!answers.iter().any(|text| text.contains("RESULT")), "{answers:?}");

    // 恢复后同角色的新调用不能认领历史子会话；重新读取文件必须得到新结果。
    let id = live.native();
    let Live { handle, dir, .. } = live;
    handle.stop().await.unwrap();
    std::fs::write(dir.path().join("a.txt"), "FRESH-RESUME-42\n").unwrap();
    let mut live = Live::open_in(dir, "full", json!({"persist":true,"skip_history":true}), None, Some(id.clone())).await;
    let got = live.run("Call invoke_subagent once, TypeName research and Role File Reader, to read a.txt again and report its first line. Wait for its result and reply with that line.").await;
    assert!(message(&got).contains("FRESH-RESUME-42"), "{got:#?}");
    assert!(got.iter().any(|event| matches!(event, SessionEventBody::Subagent(card)
        if card.status == SubagentStatus::Completed)), "{got:#?}");
    assert!(got.iter().any(|event| matches!(event, SessionEventBody::SubagentStep { step, .. }
        if matches!(step.as_ref(), SessionEventBody::ToolCall { detail, .. } if detail.contains("FRESH-RESUME-42")))), "{got:#?}");
    assert!(!got.iter().any(|event| matches!(event, SessionEventBody::Subagent(card)
        if card.status == SubagentStatus::Completed && card.result.contains("alpha"))), "{got:#?}");

    // 完整回放仍能显示两次派发各自的结果。
    live.handle.stop().await.unwrap();
    let history = AntigravityAdapter::new().import_history(&id, &live.dir.path().to_string_lossy()).await.unwrap();
    for expected in ["alpha", "FRESH-RESUME-42"] {
        assert!(history.iter().any(|event| matches!(event, SessionEventBody::SubagentStep { step, .. }
            if matches!(step.as_ref(), SessionEventBody::ToolCall { detail, .. } if detail.contains(expected)))), "{history:#?}");
    }

    // 删掉父会话时，子 Agent 自己的会话也要一起删掉。
    let children: Vec<String> = std::fs::read_dir(directory::brain_dir(&live.native()).unwrap().join(".system_generated").join("subagents"))
        .unwrap()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.path().file_stem()?.to_str().map(str::to_string))
        .collect();
    assert!(!children.is_empty());
    assert!(children.iter().all(|child| directory::data_dir().unwrap().join("conversations").join(format!("{child}.db")).is_file()), "{children:?}");
    live.close().await;
    assert!(children.iter().all(|child| directory::is_gone(child)), "{children:?}");
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_parent_keeps_working_after_a_subagent_reports() {
    let mut live = Live::open("ask", persist(), None).await;
    live.handle
        .deliver(turn("Call the invoke_subagent tool once to start exactly one subagent (TypeName research) that reads a.txt and reports its first line. When it has reported, run the shell command `echo after-subagent` with your terminal tool, then reply FINISHED."))
        .await
        .unwrap();
    let (id, kind, _, _) = live.prompt().await;
    assert_eq!(kind, PromptKind::Approval);
    live.handle.answer_prompt(&id, single("allow")).await.unwrap();
    let (status, got) = live.finished().await;
    assert_eq!(status, SessionStatus::Completed, "{got:#?}");
    assert!(got.iter().any(|event| matches!(event, SessionEventBody::ToolCall { detail, .. } if detail.contains("after-subagent"))), "{got:#?}");
    assert!(message(&got).contains("FINISHED"), "{}", message(&got));
    live.close().await;
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_task_list_becomes_steps() {
    let mut live = Live::open("full", persist(), None).await;
    let got = live
        .run("Create your task.md artifact with a checklist of two items: 'first step' and 'second step', mark first step done by updating the artifact, then reply DONE. Do nothing else.")
        .await;
    assert!(got.iter().any(|event| matches!(event, SessionEventBody::PlanSteps { steps, .. } if steps.len() == 2)), "{got:#?}");
    assert!(!got.iter().any(|event| matches!(event, SessionEventBody::FileChange { path, .. } if path.contains("task.md"))), "{got:#?}");
    live.close().await;
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_images_reach_the_model() {
    let mut live = Live::open("full", persist(), None).await;
    let png = live.dir.path().join("red.png");
    std::fs::write(&png, red_png()).unwrap();
    live.handle
        .deliver(UserTurn { text: "What is the dominant colour of this image? One word.".into(), images: vec![png.to_string_lossy().to_string()], client_id: String::new(), annotations: vec![] })
        .await
        .unwrap();
    let (status, got) = live.finished().await;
    assert_eq!(status, SessionStatus::Completed, "{got:#?}");
    assert!(message(&got).to_lowercase().contains("red"), "{}", message(&got));
    live.close().await;
}

/// 16×16 的纯红 PNG。
fn red_png() -> Vec<u8> {
    const BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGElEQVR4nGP4z8BAEiJN9aiGUQ0MQ0kDAJD5/wGaM2eTAAAAAElFTkSuQmCC";
    let table = |byte: u8| match byte {
        b'A'..=b'Z' => byte - b'A',
        b'a'..=b'z' => byte - b'a' + 26,
        b'0'..=b'9' => byte - b'0' + 52,
        b'+' => 62,
        _ => 63,
    };
    let mut out = Vec::new();
    for chunk in BASE64.trim_end_matches('=').as_bytes().chunks(4) {
        let mut bits = 0u32;
        for byte in chunk {
            bits = (bits << 6) | table(*byte) as u32;
        }
        bits <<= 6 * (4 - chunk.len());
        out.extend_from_slice(&bits.to_be_bytes()[1..chunk.len()]);
    }
    out
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_goal_runs_and_completes() {
    let mut live = Live::open("full", persist(), None).await;
    live.handle.set_goal("create done.txt containing the single word ok, then stop").await.unwrap();
    let got = live.until(|event| matches!(event, SessionEventBody::Goal { status, .. } if status.as_deref() == Some("active"))).await;
    assert!(!got.is_empty());
    let got = live.until(|event| matches!(event, SessionEventBody::Goal { status, .. } if status.as_deref() == Some("complete"))).await;
    assert!(live.dir.path().join("done.txt").exists(), "{got:#?}");
    assert!(!message(&got).contains("GOAL_COMPLETE"), "{}", message(&got));
    live.handle.clear_goal().await.unwrap();
    live.until(|event| matches!(event, SessionEventBody::Goal { objective: None, .. })).await;
    live.close().await;
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_paused_goal_can_resume_after_reopening() {
    let mut live = Live::open("full", persist(), None).await;
    let id = live.native();
    live.handle.set_goal("Reply OK without using tools, then mark this goal complete.").await.unwrap();
    live.handle.set_goal_status("paused").await.unwrap();
    live.finished().await;
    live.drain();
    let saved = live.seen.iter().rev().find(|event| matches!(event, SessionEventBody::Goal { .. })).unwrap().clone();
    assert!(matches!(&saved, SessionEventBody::Goal { status, .. } if status.as_deref() == Some("paused")));
    let Live { handle, dir, .. } = live;
    handle.stop().await.unwrap();

    // 和 daemon 一样传最后一条持久化事件。打开本身不能重新启动目标。
    let mut again = Live::open_in(dir, "full", json!({"persist":true,"skip_history":true,"saved_goal":saved}), None, Some(id)).await;
    assert!(!again.seen.iter().any(|event| matches!(event, SessionEventBody::StatusChanged { status: SessionStatus::Running })));
    again.handle.set_goal_status("active").await.unwrap();
    again.until(|event| matches!(event, SessionEventBody::Goal { status, .. } if status.as_deref() == Some("complete"))).await;
    again.handle.clear_goal().await.unwrap();
    again.until(|event| matches!(event, SessionEventBody::Goal { objective: None, .. })).await;
    again.close().await;
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_workbench_mcp_is_registered_and_instructed() {
    let (url, hits) = fake_mcp().await;
    let mcp = WorkbenchMcp { url, token: "t0k".into(), child: false };
    let mut live = Live::open("ask", persist(), Some(mcp)).await;
    let got = live.run("Call the aiwb_ping tool from the aiwb MCP server and tell me the word it returned. Use no other tools.").await;
    assert!(message(&got).contains("PAPAYA"), "{got:#?}");
    assert!(got.iter().any(|event| matches!(event, SessionEventBody::ToolCall { name, .. } if name == "mcp__aiwb__aiwb_ping")), "{got:#?}");
    assert!(!got.iter().any(|event| matches!(event, SessionEventBody::Prompt { .. })), "工作台工具不该弹审批：{got:#?}");
    assert!(hits.lock().unwrap().iter().all(|auth| auth == "Bearer t0k"));
    let got = live.run("Does your system prompt mention aiwb_subtask_create? Answer YES or NO only.").await;
    assert!(message(&got).to_uppercase().contains("YES"), "{}", message(&got));
    live.close().await;
}

/// 够 agy 认的最小 MCP 服务：`initialize`、`tools/list`、`tools/call`。
async fn fake_mcp() -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let hits = Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = hits.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { return };
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head_end, length, auth) = loop {
                    let Ok(read) = stream.read(&mut chunk).await else { return };
                    if read == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..read]);
                    let Some(end) = buf.windows(4).position(|part| part == b"\r\n\r\n") else { continue };
                    let head = String::from_utf8_lossy(&buf[..end]).to_lowercase();
                    let field = |name: &str| head.lines().find_map(|line| line.strip_prefix(name).map(|rest| rest.trim().to_string()));
                    let raw = String::from_utf8_lossy(&buf[..end]).to_string();
                    let auth = raw.lines().find_map(|line| line.strip_prefix("Authorization:").or_else(|| line.strip_prefix("authorization:")).map(|rest| rest.trim().to_string()));
                    break (end + 4, field("content-length:").and_then(|len| len.parse::<usize>().ok()).unwrap_or(0), auth);
                };
                while buf.len() < head_end + length {
                    let Ok(read) = stream.read(&mut chunk).await else { return };
                    if read == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..read]);
                }
                if let Some(auth) = auth {
                    seen.lock().unwrap().push(auth);
                }
                let body: Value = serde_json::from_slice(&buf[head_end..head_end + length]).unwrap_or(Value::Null);
                let id = body.get("id").cloned();
                let method = body.get("method").and_then(Value::as_str).unwrap_or("");
                let result = match method {
                    "initialize" => json!({"protocolVersion":body["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"t","version":"1"}}),
                    "tools/list" => json!({"tools":[{"name":"aiwb_ping","description":"returns the magic word","inputSchema":{"type":"object","properties":{}}}]}),
                    "tools/call" => json!({"content":[{"type":"text","text":"PAPAYA"}]}),
                    _ => json!({}),
                };
                let reply = match id {
                    Some(id) => {
                        let payload = json!({"jsonrpc":"2.0","id":id,"result":result}).to_string();
                        format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}", payload.len())
                    }
                    None => "HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string(),
                };
                let _ = stream.write_all(reply.as_bytes()).await;
            });
        }
    });
    (url, hits)
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_extra_directories_and_moving_the_workdir() {
    let extra = tempfile::tempdir().unwrap();
    std::fs::write(extra.path().join("e.txt"), "from-extra\n").unwrap();
    let mut live = Live::open("ask", persist(), None).await;
    let root = extra.path().to_string_lossy().to_string();
    live.handle.set_sandbox("ask", false, std::slice::from_ref(&root), "").unwrap();
    live.handle
        .deliver(turn(&format!("Read the file {root}\\e.txt with your read tool and reply with its content. Then, using your terminal tool with no explicit working directory change, run Get-ChildItem -Name and list what you see.")))
        .await
        .unwrap();
    let mut got = Vec::new();
    loop {
        let event = live.next().await;
        if let SessionEventBody::Prompt { prompt_id, header, .. } = &event {
            assert_eq!(header, "command", "额外目录里的读取不该弹审批");
            live.handle.answer_prompt(prompt_id, single("allow")).await.unwrap();
        }
        let done = matches!(event, SessionEventBody::StatusChanged { status: SessionStatus::Completed });
        got.push(event);
        if done {
            break;
        }
    }
    let text = message(&got);
    assert!(text.contains("from-extra"), "{text}");
    assert!(text.contains("a.txt"), "命令要跑在项目目录：{text}");
    let id = live.native();
    let Live { handle, dir, .. } = live;
    handle.stop().await.unwrap();

    let moved = tempfile::tempdir().unwrap();
    std::fs::write(moved.path().join("moved.txt"), "x").unwrap();
    let mut live = Live::open_in(moved, "full", json!({"persist":true,"skip_history":true}), None, Some(id)).await;
    let got = live.run("Use your terminal tool to list the files in the project directory, and name them. Also say what was in e.txt earlier.").await;
    let text = message(&got);
    assert!(text.contains("moved.txt") && text.contains("from-extra"), "{text}");
    drop(dir);
    live.close().await;
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_subscription_windows() {
    let usage = AntigravityAdapter::new().subscription_usage().await.unwrap();
    assert!(!usage.windows.is_empty());
    for window in &usage.windows {
        let remaining = window.remaining_percent.unwrap();
        assert!((0.0..=100.0).contains(&remaining), "{window:?}");
        assert!(window.resets_at_ms.is_some(), "{window:?}");
        assert!(window.label.contains("每周") || window.label.contains("5 小时"), "{window:?}");
    }
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_mcp_servers_are_managed_with_the_cli() {
    let config = directory::data_dir().unwrap().parent().unwrap().join("config").join("mcp_config.json");
    let before = std::fs::read(&config).ok();
    let driver = AntigravityAdapter::new().mcp().unwrap();
    let spec = |name: &str, transport: &str| McpAddSpec {
        name: name.into(),
        transport: transport.into(),
        command: String::new(),
        args: Vec::new(),
        env: Vec::new(),
        url: String::new(),
        bearer_token_env_var: String::new(),
        headers: Vec::new(),
        scope: String::new(),
        client_id: String::new(),
        client_secret: String::new(),
        oauth_resource: String::new(),
        callback_port: String::new(),
        oauth_registration: String::new(),
    };
    let mut http = spec("aiwb-live-http", "http");
    http.url = "https://example.com/mcp".into();
    http.headers = vec![McpPair { key: "Authorization".into(), value: "Bearer x".into() }];
    let mut stdio = spec("aiwb-live-stdio", "stdio");
    stdio.command = "npx".into();
    stdio.args = vec!["-y".into(), "server".into()];
    stdio.env = vec![McpPair { key: "A".into(), value: "1".into() }];
    let outcome = async {
        driver.add(&http).await?;
        driver.add(&stdio).await?;
        let rows = driver.list().await?;
        let row = |name: &str| rows.iter().find(|row| row.name == name).cloned().ok_or(format!("没有 {name}"));
        let http_row = row("aiwb-live-http")?;
        assert_eq!((http_row.transport.as_str(), http_row.url.as_str(), http_row.enabled), ("http", "https://example.com/mcp", Some(true)));
        let stdio_row = row("aiwb-live-stdio")?;
        assert_eq!(stdio_row.transport, "stdio");
        assert!(stdio_row.command.contains("npx"), "{stdio_row:?}");
        driver.set_enabled("aiwb-live-http", false).await?;
        assert_eq!(driver.list().await?.iter().find(|row| row.name == "aiwb-live-http").unwrap().enabled, Some(false));
        driver.set_enabled("aiwb-live-http", true).await?;
        driver.remove("aiwb-live-http", "").await?;
        driver.remove("aiwb-live-stdio", "").await?;
        let gone = driver.list().await?;
        assert!(!gone.iter().any(|row| row.name.starts_with("aiwb-live")), "{gone:?}");
        Ok::<_, String>(())
    }
    .await;
    match before {
        Some(bytes) => std::fs::write(&config, bytes).unwrap(),
        None => {
            let _ = std::fs::remove_file(&config);
        }
    }
    outcome.unwrap();
}

#[tokio::test]
#[ignore = "calls the installed and authenticated agy"]
async fn live_catalog_probe_leaves_no_thread() {
    let dir = tempfile::tempdir().unwrap();
    let root = directory::data_dir().unwrap().join("conversations");
    let count = || std::fs::read_dir(&root).unwrap().count();
    let before = count();
    let (tx, _rx) = mpsc::unbounded_channel();
    let handle = AntigravityAdapter::new()
        .start_session(
            SessionContext {
                project_path: dir.path().to_string_lossy().to_string(),
                access_mode: None,
                resume_native_id: None,
                workbench_mcp: None,
                options: json!({}),
            },
            tx,
        )
        .await
        .unwrap();
    assert!(!handle.catalog().await.unwrap().models.is_empty());
    let id = handle.native_id().unwrap();
    handle.stop().await.unwrap();
    assert!(!root.join(format!("{id}.db")).exists());
    assert!(!directory::brain_dir(&id).unwrap().exists());
    let _ = before;
    assert!(Path::new(&root).is_dir());
}
