//! 真实 CLI 跑嵌套任务：父任务经工作台 MCP 开一个换了 Agent 的子任务，子任务跑完父会话收到回报。
//! 独立聊天也一样，子任务挂在聊天下面、用同一个文件夹；用户只说一句大白话时 Agent 要自己选这个工具。
//! 要本机装好并登录 Codex、Claude Code 和 Cursor Agent，会花一点额度：
//! `cargo test -p aiwb-daemon --test subtasks_cli -- --ignored --nocapture --test-threads=1`

use std::sync::Arc;
use std::time::{Duration, Instant};

use aiwb_core::DaemonInfo;
use aiwb_daemon::{router, Services};
use aiwb_store::Store;
use serde_json::{json, Value};

struct Live {
    services: Arc<Services>,
    project_id: String,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}

async fn live() -> Live {
    let dir = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let info = DaemonInfo {
        version: "test".into(),
        build: String::new(),
        pid: std::process::id(),
        port,
        token: "t".into(),
    };
    let store = Arc::new(Store::open(&dir.path().join("db.sqlite")).unwrap());
    let services = Arc::new(Services::new(store, info, dir.path().to_path_buf()));
    services.start_subtask_reports();
    let app = router(services.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let project = services
        .dispatch("projects.add", json!({ "path": project_dir.path().to_string_lossy() }))
        .await
        .unwrap();
    Live {
        services,
        project_id: project["id"].as_str().unwrap().to_string(),
        _dirs: (dir, project_dir),
    }
}

impl Live {
    async fn tasks(&self) -> Vec<Value> {
        let tasks = self.services.dispatch("tasks.list", json!({})).await.unwrap();
        tasks.as_array().unwrap().clone()
    }

    async fn events(&self, task: &Value) -> Vec<Value> {
        let session = task["sessions"].as_array().unwrap().last().unwrap()["id"].as_str().unwrap().to_string();
        let feed = self.services.snapshot(&format!("session:{session}"), &json!({})).unwrap();
        feed["events"].as_array().cloned().unwrap_or_default()
    }

    async fn wait<F: Fn(&[Value]) -> bool>(&self, what: &str, done: F) -> Vec<Value> {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(600) {
            let tasks = self.tasks().await;
            if done(&tasks) {
                return tasks;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let tasks = self.tasks().await;
        for task in &tasks {
            eprintln!("{} {}", task["title"], serde_json::to_string_pretty(&self.events(task).await).unwrap());
        }
        panic!("等不到：{what}");
    }
}

fn answers(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter(|event| event["kind"] == "agent-message")
        .filter_map(|event| event["text"].as_str().map(str::to_string))
        .collect()
}

/// 照着写明的工具说明开一个回 PONG 的子任务。`standalone` 时父任务是独立聊天。
async fn parent_opens_child(parent_agent: &str, parent_model: Option<&str>, child_agent: &str, standalone: bool) {
    let prompt = format!(
        "Use the aiwb_subtask_create tool with initiation \"user_asked\" to open exactly one subtask: \
         agent \"{child_agent}\", title \"pong\", prompt \"Reply with exactly the word PONG and nothing else. Do not run any tools.\". \
         After the tool returns, end your turn immediately without polling. \
         When the subtask's result later arrives in a message, reply with the subtask's answer word only."
    );
    opens_child(parent_agent, parent_model, child_agent, standalone, &prompt).await;
}

async fn opens_child(parent_agent: &str, parent_model: Option<&str>, child_agent: &str, standalone: bool, prompt: &str) {
    let live = live().await;
    let mut options = json!({});
    if let Some(model) = parent_model {
        options["model"] = json!(model);
    }
    let mut params = json!({ "agent": parent_agent, "prompt": prompt, "options": options });
    if !standalone {
        params["projectId"] = json!(live.project_id);
    }
    let parent = live.services.dispatch("tasks.create", params).await.unwrap();
    let parent_id = parent["id"].as_str().unwrap().to_string();

    let tasks = live
        .wait("子任务开出来并跑完", |tasks| {
            tasks.iter().any(|task| {
                task["parentTaskId"] == parent_id
                    && task["attention"]["state"] == "done"
                    && task["attention"]["preview"].as_str().is_some_and(|text| text.contains("PONG"))
            })
        })
        .await;
    let child = tasks.iter().find(|task| task["parentTaskId"] == parent_id).unwrap().clone();
    assert_eq!(child["sessions"][0]["agent"], child_agent);
    if standalone {
        assert!(child["projectId"].is_null());
        assert_eq!(child["workspace"], parent["workspace"], "和聊天同一个文件夹");
    }
    // 父时间线里有一行子任务；没有用 shell 去跑另一个 Agent 的 CLI。
    let parent_now = live.tasks().await.into_iter().find(|task| task["id"] == parent_id).unwrap();
    let parent_events = live.events(&parent_now).await;
    let rows: Vec<&Value> = parent_events
        .iter()
        .filter(|event| event["kind"] == "subtask-offer" && event["resolution"]["kind"] == "accepted")
        .collect();
    assert_eq!(rows.len(), 1, "父时间线里没有子任务行");
    assert_eq!(rows[0]["resolution"]["task_ids"][0], child["id"]);
    let shelled: Vec<&Value> = parent_events
        .iter()
        .filter(|event| event["kind"] == "tool-call")
        .filter(|event| {
            let summary = event["summary"].as_str().unwrap_or("");
            ["cursor-agent", "agent -p", "claude -p", "codex exec"].iter().any(|cli| summary.contains(cli))
        })
        .collect();
    assert!(shelled.is_empty(), "用 shell 跑了别的 Agent：{shelled:#?}");
    let child_answers = answers(&live.events(&child).await);
    eprintln!("子任务回答：{child_answers:?}");
    assert!(child_answers.iter().any(|text| text.contains("PONG")));

    let parent_id_ref = parent_id.clone();
    let tasks = live
        .wait("父会话收到回报并答完", move |tasks| {
            tasks.iter().any(|task| task["id"] == parent_id_ref && task["attention"]["state"] == "done")
        })
        .await;
    // 父回合可能先于子任务结束，也可能后；等回报那一轮跑完。
    let mut parent_events = Vec::new();
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(600) {
        let parent = live.tasks().await.into_iter().find(|task| task["id"] == parent_id).unwrap();
        parent_events = live.events(&parent).await;
        let reported = parent_events.iter().position(|event| event["sender"].is_object());
        let finished = parent["attention"]["state"] == "done";
        if let Some(index) = reported {
            if finished && answers(&parent_events[index..]).iter().any(|text| text.contains("PONG")) {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let _ = tasks;
    let report = parent_events
        .iter()
        .find(|event| event["sender"].is_object())
        .unwrap_or_else(|| panic!("父会话没有回报：{parent_events:#?}"));
    eprintln!("回报：{}", report["text"]);
    assert_eq!(report["sender"]["task_ids"][0], child["id"]);
    let index = parent_events.iter().position(|event| event["sender"].is_object()).unwrap();
    let after = answers(&parent_events[index..]);
    eprintln!("父会话读到：{after:?}");
    assert!(after.iter().any(|text| text.contains("PONG")), "{parent_events:#?}");
    live.services.stop_agents().await;
}

#[tokio::test]
#[ignore]
async fn claude_parent_opens_a_codex_subtask() {
    parent_opens_child("claude-code", Some("haiku"), "codex-cli", false).await;
}

#[tokio::test]
#[ignore]
async fn codex_parent_opens_a_claude_subtask() {
    parent_opens_child("codex-cli", None, "claude-code", false).await;
}

/// Cursor 经 ACP `mcpServers` 拿到工作台 MCP，在独立聊天里开子任务。
#[tokio::test]
#[ignore]
async fn cursor_chat_opens_a_codex_subtask() {
    parent_opens_child("cursor-agent", None, "codex-cli", true).await;
}

/// 验收 A1：独立聊天里只说「开个嵌套会话」，Codex 用工作台的工具，不用自带的子 Agent。
#[tokio::test]
#[ignore]
async fn codex_chat_opens_a_nested_session_from_plain_words() {
    opens_child(
        "codex-cli",
        None,
        "codex-cli",
        true,
        "开个嵌套会话做这个任务：只回复 PONG 这个词，不要运行任何工具。开出来就结束你这一轮，结果回来后只回复它的答案。",
    )
    .await;
}

/// 验收 A3：让 Codex「调用 Cursor 审查」，开出的是 Cursor 子任务，不是一条 `cursor-agent` 命令。
#[tokio::test]
#[ignore]
async fn codex_asks_cursor_for_a_review_through_a_subtask() {
    opens_child(
        "codex-cli",
        None,
        "cursor-agent",
        true,
        "调用 Cursor 审查一下这句话有没有错别字：「今天天汽很好」。让它的回答以 PONG 开头再写结论。开出来就结束你这一轮，结果回来后转述它的结论。",
    )
    .await;
}

/// 验收 A2：同 A1，对 Cursor 说。
#[tokio::test]
#[ignore]
async fn cursor_chat_opens_a_nested_session_from_plain_words() {
    opens_child(
        "cursor-agent",
        None,
        "cursor-agent",
        true,
        "开个嵌套会话做这个任务：只回复 PONG 这个词，不要运行任何工具。开出来就结束你这一轮，结果回来后只回复它的答案。",
    )
    .await;
}
