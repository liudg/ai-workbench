//! 报文取自 2026-10-29 本机 Cursor Agent 2026.10.22-27dcf5f 的 `agent acp` 实际收发（路径缩短）。

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::time::Instant;

use super::catalog;
use super::dialect::RULES;
use super::directory;
use super::open::{self as runtime, services_unavailable};
use super::process::version_key;
use super::prompts::{self, Pending};
use super::retry::{self, Miss};
use crate::acp::config;
use crate::acp::rpc::RpcError;
use crate::acp::updates::UpdateMap;
use crate::AgentError;
use aiwb_core::models::{
    FileStatus, PromptAnswer, PromptKind, SessionEventBody, SessionStatus, ToolStatus,
};

const PROJECT: &str = r"C:\ws";

fn map() -> UpdateMap {
    let mut map = UpdateMap::new(Path::new(PROJECT), &RULES);
    map.begin_turn("t1");
    map
}

fn apply_all(map: &mut UpdateMap, updates: &[Value]) -> Vec<SessionEventBody> {
    updates.iter().flat_map(|update| map.apply(update)).collect()
}

/// 服务初始化时断网，`cursor/list_available_models` 的实际回包。
#[test]
fn services_error_is_retried_but_auth_is_not() {
    let services = RpcError::from_value(&json!({
        "code": -32603,
        "message": "Internal error",
        "data": {"message": "Failed to initialize ACP services"}
    }));
    assert!(services_unavailable(&services));
    let other = RpcError::from_value(&json!({"code": -32603, "message": "Internal error"}));
    assert!(!services_unavailable(&other));
    let auth = RpcError::from_value(&json!({"code": -32000, "message": "Authentication required"}));
    assert!(!services_unavailable(&auth));
}

#[test]
fn an_empty_or_blank_model_list_does_not_count() {
    assert!(catalog::has_models(&json!({"models":[{"value":"gpt-5.5","name":"GPT-5.5"}]})));
    assert!(!catalog::has_models(&json!({"models":[]})));
    assert!(!catalog::has_models(&json!({"models":[{"value":"  "}]})));
    assert!(!catalog::has_models(&json!({})));
}

/// 按顺序吐出 `script` 里的结果，返回 `(结果, 调用次数)`。
fn scripted(script: Vec<Result<&'static str, Miss>>) -> (impl FnMut() -> std::future::Ready<Result<&'static str, Miss>>, Arc<AtomicU32>) {
    let calls = Arc::new(AtomicU32::new(0));
    let counter = calls.clone();
    let mut script = script.into_iter();
    let next = move || {
        counter.fetch_add(1, Ordering::SeqCst);
        std::future::ready(script.next().expect("多取了一次"))
    };
    (next, calls)
}

#[tokio::test(start_paused = true)]
async fn empty_replies_are_fetched_again_in_the_same_process() {
    let (fetch, calls) = scripted(vec![
        Err(Miss::Empty),
        Err(Miss::Services("Failed to initialize ACP services".into())),
        Ok("models"),
    ]);
    let started = Instant::now();
    assert_eq!(retry::refetch(fetch).await.unwrap(), "models");
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert_eq!(started.elapsed(), retry::REFETCH_WAIT * 3);
}

#[tokio::test(start_paused = true)]
async fn refetching_stops_at_the_limit() {
    let script = (0..=retry::REFETCHES).map(|_| Err(Miss::Empty)).collect();
    let (fetch, calls) = scripted(script);
    assert!(matches!(retry::refetch(fetch).await, Err(Miss::Empty)));
    assert_eq!(calls.load(Ordering::SeqCst), retry::REFETCHES + 1);
}

#[tokio::test(start_paused = true)]
async fn a_stalled_process_is_not_asked_again() {
    let (fetch, calls) = scripted(vec![Err(Miss::Stalled)]);
    assert!(matches!(retry::refetch(fetch).await, Err(Miss::Stalled)));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn a_new_process_recovers_from_a_stall() {
    let (launch, calls) = scripted(vec![Err(Miss::Stalled), Ok("session")]);
    assert_eq!(retry::with_restarts(launch).await.unwrap(), "session");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn restarts_stop_at_the_limit_with_a_clear_error() {
    let script = (0..retry::PROCESSES).map(|_| Err(Miss::Stalled)).collect();
    let (launch, calls) = scripted(script);
    let message = retry::with_restarts(launch).await.unwrap_err().to_string();
    assert_eq!(calls.load(Ordering::SeqCst), retry::PROCESSES);
    assert!(message.contains("cursor/list_available_models 一直没有回应"), "{message}");
    assert!(message.contains("请检查网络或代理"), "{message}");

    let script = (0..retry::PROCESSES).map(|_| Err(Miss::Empty)).collect();
    let (launch, _) = scripted(script);
    let message = retry::with_restarts(launch).await.unwrap_err().to_string();
    assert!(message.contains("回复一直是空的"), "{message}");
}

#[tokio::test(start_paused = true)]
async fn a_fatal_error_is_reported_without_restarting() {
    let login = "Cursor Agent 还没有登录。请在终端运行 `agent login` 后再试。";
    let (launch, calls) = scripted(vec![Err(Miss::Fatal(AgentError::Runtime(login.into())))]);
    let message = retry::with_restarts(launch).await.unwrap_err().to_string();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(message.contains(login), "{message}");
}

/// 连起十次会话，每次都要拿到模型目录。`HTTPS_PROXY` 指向故障代理就能验证重试。
#[tokio::test(flavor = "multi_thread")]
#[ignore = "calls the local Cursor Agent CLI"]
async fn cold_starts_always_get_the_model_catalog() {
    let project = std::env::temp_dir().join(format!("aiwb-cursor-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&project).unwrap();
    let mut failures = Vec::new();
    for round in 1..=10 {
        let started = std::time::Instant::now();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let opened = runtime::open(
            runtime::Open {
                project_path: project.to_string_lossy().to_string(),
                access_mode: None,
                resume: None,
                persist: true,
                replay_history: true,
                workbench_mcp: None,
            },
            tx,
        )
        .await;
        match opened {
            Ok(shared) => {
                let models = shared.catalog.lock().unwrap().models.len();
                println!("#{round} models={models} {:?}", started.elapsed());
                if models == 0 {
                    failures.push(format!("#{round} 模型目录是空的"));
                }
                shared.shutdown_and_wait().await;
                let id = shared.session_id().expect("persist 时有会话 id");
                directory::remove(&id).unwrap();
            }
            Err(err) => {
                println!("#{round} {err} {:?}", started.elapsed());
                failures.push(format!("#{round} {err}"));
            }
        }
    }
    let _ = std::fs::remove_dir_all(&project);
    assert!(failures.is_empty(), "{failures:?}");
}

#[test]
fn text_and_thought_chunks_stream_into_one_message_each() {
    let mut map = map();
    let events = apply_all(
        &mut map,
        &[
            json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"The"}}),
            json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":" user wants hi."}}),
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"h"}}),
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"i"}}),
        ],
    );
    let SessionEventBody::Thinking { text, stream_id } = &events[1] else { panic!("{events:?}") };
    assert_eq!(text, "The user wants hi.");
    let think = stream_id.clone();
    let SessionEventBody::AgentMessage { text, stream_id, .. } = &events[3] else { panic!() };
    assert_eq!(text, "hi");
    assert_ne!(stream_id, &think);
    let SessionEventBody::AgentMessage { stream_id: first, .. } = &events[2] else { panic!() };
    assert_eq!(first, stream_id);
}

#[test]
fn command_tool_fills_in_from_updates_and_keeps_exit_code() {
    let id = "call-1\nfc_1";
    let mut map = map();
    let events = apply_all(
        &mut map,
        &[
            json!({"sessionUpdate":"tool_call","toolCallId":id,"title":"Terminal","kind":"execute","status":"pending","rawInput":{}}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":id,"title":"`git status`","rawInput":{"command":"git status"}}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":id,"status":"in_progress"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":id,"status":"completed","rawOutput":{"exitCode":0,"stdout":"On branch master\n","stderr":""}}),
        ],
    );
    assert_eq!(events.len(), 4);
    let SessionEventBody::ToolCall { name, summary, status, stream_id, .. } = &events[0] else { panic!() };
    assert_eq!(name, "command");
    assert_eq!(summary, "Terminal");
    assert_eq!(*status, ToolStatus::Running);
    assert!(!stream_id.as_deref().unwrap().contains('\n'));
    let SessionEventBody::ToolCall { summary, detail, status, exit_code, .. } = &events[3] else { panic!() };
    assert_eq!(summary, "git status");
    assert_eq!(detail, "On branch master");
    assert_eq!(*status, ToolStatus::Completed);
    assert_eq!(*exit_code, Some(0));

    let failed = map.apply(&json!({"sessionUpdate":"tool_call_update","toolCallId":id,"rawOutput":{"exitCode":2,"stdout":"","stderr":"boom"}}));
    let SessionEventBody::ToolCall { status, exit_code, .. } = &failed[0] else { panic!() };
    assert_eq!(*status, ToolStatus::Failed);
    assert_eq!(*exit_code, Some(2));
}

#[test]
fn edits_become_file_changes_from_original_text() {
    let path = format!(r"{PROJECT}\hello.txt");
    let mut map = map();
    let created = apply_all(
        &mut map,
        &[
            json!({"sessionUpdate":"tool_call","toolCallId":"e1","title":"Edit File","kind":"edit","status":"pending","rawInput":{}}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"e1","title":format!("Edit `{path}`"),"rawInput":{"path":path},"locations":[{"path":path}]}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"e1","status":"completed","content":[{"type":"diff","path":path,"oldText":"-- /dev/null","newText":format!("++ b/{path}\nhello world")}]}),
        ],
    );
    let SessionEventBody::ToolCall { name, summary, .. } = &created[1] else { panic!() };
    assert_eq!(name, "Edit");
    assert_eq!(summary, "hello.txt");
    let SessionEventBody::FileChange { path, status, added, removed, diff, .. } = &created[3] else { panic!("{created:?}") };
    assert_eq!(path, "hello.txt");
    assert_eq!(*status, FileStatus::Added);
    assert_eq!((*added, *removed), (1, 0));
    assert!(diff.contains("+hello world"), "{diff}");
    assert_eq!(diff.lines().filter(|line| line.contains("++ b/")).count(), 1, "{diff}");
    assert!(matches!(created[4], SessionEventBody::TurnDiff { .. }));
    assert!(matches!(created[5], SessionEventBody::TurnChanges { .. }));

    let edited = apply_all(
        &mut map,
        &[
            json!({"sessionUpdate":"tool_call","toolCallId":"e2","title":"Edit File","kind":"edit","status":"pending","rawInput":{}}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"e2","status":"completed","content":[{"type":"diff","path":path,"oldText":"hello world\n","newText":"hello cursor\n"}]}),
        ],
    );
    let SessionEventBody::TurnChanges { files, .. } = edited.last().unwrap() else { panic!() };
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].status, FileStatus::Added);
    assert!(files[0].diff.contains("+hello cursor"));
    assert!(!files[0].diff.contains("hello world"));
    assert!(map.last_diff.contains("+hello cursor"));
}

#[test]
fn replay_rebuilds_turns_from_user_chunks() {
    let mut map = UpdateMap::new(Path::new(PROJECT), &RULES);
    let mut events = apply_all(
        &mut map,
        &[
            json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Create hello.txt"}}),
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Creating."}}),
            json!({"sessionUpdate":"tool_call","toolCallId":"replay-0-3","title":"`git status`","kind":"execute","status":"pending","rawInput":{"command":"git status"}}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"replay-0-3","status":"completed","rawOutput":{"exitCode":0,"stdout":"ok","stderr":""}}),
            json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Thanks"}}),
        ],
    );
    events.extend(map.finish_replay());
    let kinds: Vec<&str> = events
        .iter()
        .map(|event| match event {
            SessionEventBody::UserMessage { .. } => "user",
            SessionEventBody::TurnAnchor { .. } => "anchor",
            SessionEventBody::AgentMessage { .. } => "agent",
            SessionEventBody::ToolCall { .. } => "tool",
            SessionEventBody::StatusChanged { status: SessionStatus::Completed } => "done",
            _ => "other",
        })
        .collect();
    assert_eq!(
        kinds,
        ["user", "anchor", "agent", "tool", "tool", "done", "user", "anchor", "done"]
    );
    let SessionEventBody::UserMessage { text, .. } = &events[6] else { panic!() };
    assert_eq!(text, "Thanks");
}

#[test]
fn plan_entries_and_mode_switch_map_to_plan_events() {
    let mut map = map();
    let events = apply_all(
        &mut map,
        &[
            json!({"sessionUpdate":"current_mode_update","currentModeId":"plan"}),
            json!({"sessionUpdate":"plan","entries":[{"content":"Write README","priority":"medium","status":"in_progress"},{"content":"Review","priority":"low","status":"pending"}]}),
        ],
    );
    let SessionEventBody::CollaborationMode { mode } = &events[0] else { panic!() };
    assert_eq!(mode, "plan");
    let SessionEventBody::PlanSteps { steps, mode, .. } = &events[1] else { panic!() };
    assert_eq!(steps[0].status, "inProgress");
    assert_eq!(steps[1].status, "pending");
    assert_eq!(mode.as_deref(), Some("plan"));

    let merged = map.apply_todos(&json!({"toolCallId":"t","merge":false,"todos":[{"id":"a","content":"A","status":"pending"},{"id":"b","content":"B","status":"pending"}]}));
    assert!(matches!(&merged[0], SessionEventBody::PlanSteps { steps, .. } if steps.len() == 2));
    let merged = map.apply_todos(&json!({"toolCallId":"t","merge":true,"todos":[{"id":"a","content":"A","status":"completed"}]}));
    let SessionEventBody::PlanSteps { steps, .. } = &merged[0] else { panic!() };
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0].status, "completed");
}

#[test]
fn generated_image_attaches_to_its_tool_card() {
    let mut map = map();
    map.apply(&json!({"sessionUpdate":"tool_call","toolCallId":"g1","title":"Generate Image","kind":"other","status":"pending","rawInput":{}}));
    let events = map.attach_image(&json!({"toolCallId":"g1","description":"a red bike","filePath":"C:\\ws\\bike.png"}));
    let SessionEventBody::ToolCall { name, summary, images, .. } = &events[0] else { panic!() };
    assert_eq!(name, "image_generation");
    assert_eq!(summary, "a red bike");
    assert_eq!(images, &vec!["C:\\ws\\bike.png".to_string()]);
}

#[test]
fn permission_request_uses_cursor_options_and_answers_by_option_id() {
    let params = json!({
        "sessionId": "s",
        "toolCall": {"toolCallId":"c1","title":"`git status`","kind":"execute","status":"pending","content":[{"type":"content","content":{"type":"text","text":"Not in allowlist: git status"}}]},
        "options": [
            {"optionId":"allow-once","name":"Allow once","kind":"allow_once"},
            {"optionId":"allow-always","name":"Allow always","kind":"allow_always"},
            {"optionId":"reject-once","name":"Reject","kind":"reject_once"}
        ]
    });
    assert_eq!(crate::acp::permission::allow_once(&params).as_deref(), Some("allow-once"));
    let id = prompts::prompt_id(&json!(0));
    let (event, pending) = crate::acp::permission::permission_prompt(&id, &params);
    let SessionEventBody::Prompt { prompt_kind, options, header, body, body_kind, reason, .. } = event else { panic!() };
    assert_eq!(prompt_kind, PromptKind::Approval);
    assert_eq!(header, "command");
    assert_eq!(body, "git status");
    assert_eq!(body_kind, "command");
    assert_eq!(reason, "Not in allowlist: git status");
    let slots: Vec<&str> = options.iter().map(|option| option.slot.as_str()).collect();
    assert_eq!(slots, ["primary", "scoped", "deny"]);

    let (reply, label) = crate::acp::permission::respond(&pending, &PromptAnswer::Single { value: "allow-always".into() }).unwrap();
    assert_eq!(reply, json!({"outcome":{"outcome":"selected","optionId":"allow-always"}}));
    assert_eq!(label, "总是允许");
    let (reply, _) = crate::acp::permission::respond(&pending, &PromptAnswer::Single { value: "reject".into() }).unwrap();
    assert_eq!(reply["outcome"]["optionId"], "reject-once");
}

#[test]
fn questions_answer_with_option_ids() {
    let params = json!({
        "toolCallId": "q",
        "title": "Tone",
        "questions": [
            {"id":"tone","prompt":"Which tone?","options":[{"id":"formal","label":"Formal"},{"id":"casual","label":"Casual"}],"allowMultiple":false},
            {"id":"parts","prompt":"Which parts?","options":[{"id":"a","label":"Intro"},{"id":"b","label":"Usage"}],"allowMultiple":true}
        ]
    });
    let (event, pending) = prompts::question_prompt("acp-1", &params);
    let SessionEventBody::Prompt { prompt_kind, questions, question, .. } = event else { panic!() };
    assert_eq!(prompt_kind, PromptKind::Questions);
    assert_eq!(question, "Tone");
    assert!(questions[1].multi_select);
    assert!(!questions[0].is_other);

    let answers = HashMap::from([
        ("tone".to_string(), "Casual".to_string()),
        ("parts".to_string(), "Intro, Usage".to_string()),
    ]);
    let (reply, _) = prompts::response(&pending, &PromptAnswer::Questions { answers, skipped: false }).unwrap();
    assert_eq!(
        reply,
        json!({"outcome":{"outcome":"answered","answers":[
            {"questionId":"tone","selectedOptionIds":["casual"]},
            {"questionId":"parts","selectedOptionIds":["a","b"]}
        ]}})
    );
    let (reply, _) = prompts::response(&pending, &PromptAnswer::Questions { answers: HashMap::new(), skipped: true }).unwrap();
    assert_eq!(reply["outcome"]["outcome"], "skipped");
}

#[test]
fn plan_prompt_accepts_or_rejects() {
    let (_, pending) = prompts::plan_prompt("acp-2");
    assert!(matches!(pending, Pending::Plan));
    let (reply, _) = prompts::response(&pending, &PromptAnswer::Single { value: "accept".into() }).unwrap();
    assert!(prompts::plan_accepted(&reply));
    let (reply, _) = prompts::response(&pending, &PromptAnswer::Single { value: "reject".into() }).unwrap();
    assert_eq!(reply["outcome"]["outcome"], "rejected");
    assert_eq!(
        prompts::plan_text(&json!({"name":"README","overview":"Add docs","plan":"# Add README\n\n1. write"})),
        "# Add README\n\n1. write"
    );
    assert_eq!(
        prompts::plan_text(&json!({"name":"README","overview":"Add docs","plan":""})),
        "# README\n\nAdd docs"
    );
}

#[test]
fn model_list_maps_efforts_and_fast_tier() {
    let payload = json!({"models":[
        {"value":"default","name":"Auto","configOptions":[]},
        {"value":"grok-4.7","name":"Grok 4.7","configOptions":[
            {"id":"context","name":"Context","category":"model_config","type":"select","currentValue":"256k","options":[{"value":"256k","name":"256K"},{"value":"500k","name":"500K"}]},
            {"id":"reasoning_effort","name":"Effort","category":"thought_level","type":"select","currentValue":"high","options":[{"value":"low","name":"Low"},{"value":"high","name":"High"}]},
            {"id":"fast","name":"Fast","description":"Significantly faster but consumes more usage","category":"model_config","type":"select","currentValue":"true","options":[{"value":"false","name":"Off"},{"value":"true","name":"Fast\u{200b}\u{200b}"}]}
        ]}
    ]});
    let mut catalog = catalog::empty_catalog();
    catalog::apply_model_list(&mut catalog, &payload);
    assert_eq!(catalog.models.len(), 2);
    assert!(catalog.models[0].is_default);
    assert!(catalog.models[0].efforts.is_empty());
    let grok = &catalog.models[1];
    assert_eq!(grok.label, "Grok 4.7");
    assert_eq!(grok.default_effort, "high");
    assert_eq!(grok.efforts.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["low", "high"]);
    assert!(grok.service_tiers[0].fast);
    assert_eq!(grok.default_service_tier.as_deref(), Some("fast"));
    assert_eq!(catalog.agent, Some(aiwb_core::models::AgentKind::CursorAgent));
}

#[test]
fn session_config_finds_effort_by_category() {
    let options = vec![
        json!({"id":"mode","category":"mode","currentValue":"agent","options":[]}),
        json!({"id":"model","category":"model","currentValue":"claude-opus-5-5","options":[]}),
        json!({"id":"effort","category":"thought_level","currentValue":"medium","options":[{"value":"low","name":"Low"},{"value":"max","name":"Max"}]}),
        json!({"id":"fast","category":"model_config","currentValue":"false","options":[{"value":"false","name":"Off"},{"value":"true","name":"Fast"}]}),
    ];
    let config = config::read_config(&options);
    assert_eq!(config.model.as_deref(), Some("claude-opus-5-5"));
    assert_eq!(config.effort_id.as_deref(), Some("effort"));
    assert_eq!(config.effort.as_deref(), Some("medium"));
    assert_eq!(config.effort_values, ["low", "max"]);
    assert_eq!(config.fast, Some(false));
}

#[test]
fn commands_get_a_leading_slash() {
    let commands = config::commands(&json!({"sessionUpdate":"available_commands_update","availableCommands":[
        {"name":"simplify","description":"Find low-info comments"},
        {"name":"worktree","description":"Create a worktree","input":{"hint":"branch"}}
    ]}));
    assert_eq!(commands[0].name, "/simplify");
    assert!(!commands[0].takes_args);
    assert!(commands[1].takes_args);
}

#[test]
fn version_dirs_follow_the_launcher_script() {
    assert_eq!(version_key("2026.10.22-27dcf5f"), Some(20261022));
    assert_eq!(version_key("2026.9.3-12-30-59-abc123"), Some(20260903));
    assert_eq!(version_key("2026.10.22-27dcf5f.new"), None);
    assert_eq!(version_key("promote-staged"), None);
}

#[test]
fn prompt_blocks_carry_text_and_images() {
    let blocks = crate::acp::session::prompt_blocks("看图", &["data:image/png;base64,aGk=".into()]).unwrap();
    assert_eq!(blocks[0], json!({"type":"text","text":"看图"}));
    assert_eq!(blocks[1], json!({"type":"image","mimeType":"image/png","data":"aGk="}));
    assert!(crate::acp::session::prompt_blocks("  ", &[]).is_err());
}

/// 真实 CLI：建会话、探目录、载入空会话、删掉。要求本机已装并登录 Cursor Agent。
#[tokio::test]
#[ignore]
async fn live_acp_session_opens_and_replaces_an_empty_placeholder() {
    use crate::{AgentAdapter, SessionContext};

    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().to_string();
    let adapter = super::CursorAgentAdapter::new();
    let ctx = |resume: Option<String>| SessionContext {
        project_path: cwd.clone(),
        access_mode: Some("ask".into()),
        resume_native_id: resume,
        workbench_mcp: None,
        options: json!({ "persist": true, "skip_history": true }),
    };
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = adapter.start_session(ctx(None), tx).await.expect("start");
    let first = handle.native_id().expect("session id");
    let catalog = handle.catalog().await.unwrap();
    assert!(catalog.models.iter().any(|model| model.is_default), "{}", catalog.models.len());
    assert!(catalog.thread_model.is_some());
    handle.stop().await.unwrap();
    assert!(super::directory::is_placeholder(&first));
    assert!(adapter.import_page(&cwd, None, 100).await.unwrap().entries.iter().any(|entry| entry.native_id == first));

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = adapter.start_session(ctx(Some(first.clone())), tx).await.expect("reopen");
    let second = handle.native_id().expect("session id");
    handle.stop().await.unwrap();
    assert_ne!(first, second);
    assert!(!super::directory::is_placeholder(&first));
    adapter.delete_thread(&second).await.unwrap();
    assert!(!adapter.import_page(&cwd, None, 100).await.unwrap().entries.iter().any(|entry| entry.native_id == second));
}

/// 真实 CLI：载入一条已经聊过的会话，回放成时间线。`CURSOR_REPLAY_ID` / `CURSOR_REPLAY_CWD` 指定会话。
#[tokio::test]
#[ignore]
async fn live_acp_import_replays_a_real_session() {
    use crate::AgentAdapter;

    let (Ok(id), Ok(cwd)) = (std::env::var("CURSOR_REPLAY_ID"), std::env::var("CURSOR_REPLAY_CWD")) else {
        return;
    };
    let history = super::CursorAgentAdapter::new().import_history(&id, &cwd).await.unwrap();
    for event in &history {
        eprintln!("{}", serde_json::to_string(event).unwrap());
    }
    assert!(history.iter().any(|event| matches!(event, SessionEventBody::UserMessage { .. })));
    assert!(history.iter().any(|event| matches!(event, SessionEventBody::ToolCall { .. })));
}

/// 跑到这一轮结束。审批选「允许一次」，计划选「实施」。
async fn drive_turn(
    handle: &std::sync::Arc<dyn crate::AgentSession>,
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<SessionEventBody>,
    interrupt_on_text: bool,
) -> Vec<SessionEventBody> {
    let mut seen = Vec::new();
    let mut interrupted = false;
    loop {
        let event = tokio::time::timeout(std::time::Duration::from_secs(240), rx.recv())
            .await
            .expect("turn timed out")
            .expect("channel closed");
        eprintln!("{}", serde_json::to_string(&event).unwrap());
        match &event {
            SessionEventBody::Prompt { prompt_id, options, .. } => {
                let pick = options
                    .iter()
                    .find(|option| option.slot == "primary")
                    .expect("primary option")
                    .id
                    .clone();
                handle
                    .answer_prompt(prompt_id, PromptAnswer::Single { value: pick })
                    .await
                    .unwrap();
            }
            SessionEventBody::AgentMessage { .. } if interrupt_on_text && !interrupted => {
                interrupted = true;
                handle.interrupt().await.unwrap();
            }
            _ => {}
        }
        let done = matches!(
            &event,
            SessionEventBody::StatusChanged {
                status: SessionStatus::Completed | SessionStatus::Failed | SessionStatus::Stopped
            }
        );
        seen.push(event);
        if done {
            return seen;
        }
    }
}

fn user_turn(text: &str) -> crate::UserTurn {
    crate::UserTurn {
        text: text.into(),
        images: Vec::new(),
        client_id: String::new(),
        annotations: Vec::new(),
    }
}

/// 真实 CLI 跑完整回合（grok-4.7）：审批命令、计划模式交计划、中断、回放。要求本机已装并登录 Cursor Agent。
#[tokio::test]
#[ignore]
async fn live_acp_turns_with_approval_plan_and_cancel() {
    use crate::{AgentAdapter, SessionContext};

    let dir = tempfile::tempdir().unwrap();
    std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(dir.path())
        .status()
        .unwrap();
    std::fs::write(dir.path().join("hello.txt"), "hello\n").unwrap();
    let cwd = dir.path().to_string_lossy().to_string();
    let adapter = super::CursorAgentAdapter::new();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = adapter
        .start_session(
            SessionContext {
                project_path: cwd.clone(),
                access_mode: Some("ask".into()),
                resume_native_id: None,
                workbench_mcp: None,
                options: json!({ "persist": true }),
            },
            tx,
        )
        .await
        .expect("start");
    let native = handle.native_id().unwrap();
    while rx.try_recv().is_ok() {}
    handle.set_tuning(Some("grok-4.7".into()), None).unwrap();

    handle
        .deliver(user_turn("Run the shell command `git status` and then edit hello.txt so it says `hello cursor`. Reply with one short sentence."))
        .await
        .unwrap();
    let first = drive_turn(&handle, &mut rx, false).await;
    assert!(matches!(first.last(), Some(SessionEventBody::StatusChanged { status: SessionStatus::Completed })));
    assert!(first.iter().any(|event| matches!(event, SessionEventBody::Prompt { body_kind, .. } if body_kind == "command")));
    assert!(first.iter().any(|event| matches!(
        event,
        SessionEventBody::ToolCall { name, status: ToolStatus::Completed, exit_code: Some(0), .. } if name == "command"
    )));
    assert!(first.iter().any(|event| matches!(event, SessionEventBody::TurnChanges { files, .. } if files.iter().any(|file| file.path == "hello.txt"))));
    assert!(handle.last_turn_diff().await.unwrap().contains("+hello cursor"));
    assert_eq!(std::fs::read_to_string(dir.path().join("hello.txt")).unwrap().trim(), "hello cursor");

    handle.set_collaboration_mode("plan").unwrap();
    handle
        .deliver(user_turn("Plan adding a README.md with a short casual description. Use the CreatePlan tool to present the plan, with 2 todos."))
        .await
        .unwrap();
    let second = drive_turn(&handle, &mut rx, false).await;
    assert!(matches!(second.last(), Some(SessionEventBody::StatusChanged { status: SessionStatus::Completed })));
    assert!(second.iter().any(|event| matches!(event, SessionEventBody::PlanText { text, .. } if !text.is_empty())));
    assert!(second.iter().any(|event| matches!(event, SessionEventBody::PlanSteps { steps, .. } if steps.len() == 2)));
    assert!(second.iter().any(|event| matches!(event, SessionEventBody::CollaborationMode { mode } if mode == "default")));

    handle
        .deliver(user_turn("Count from 1 to 400, one number per line, no other text."))
        .await
        .unwrap();
    let third = drive_turn(&handle, &mut rx, true).await;
    assert!(matches!(third.last(), Some(SessionEventBody::StatusChanged { status: SessionStatus::Stopped })));
    handle.stop().await.unwrap();

    let history = adapter.import_history(&native, &cwd).await.unwrap();
    // 刚开头就中断的那一轮，Cursor 自己不存，回放里只有前两轮。
    let users: Vec<&str> = history
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::UserMessage { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert!(users.len() >= 2, "{history:?}");
    assert!(users[0].starts_with("Run the shell command"));
    assert!(users[1].starts_with("Plan adding a README.md"));
    adapter.delete_thread(&native).await.unwrap();
}
