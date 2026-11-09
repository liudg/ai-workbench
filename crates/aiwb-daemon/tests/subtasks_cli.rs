//! 真实 CLI 跑嵌套任务：父任务经工作台 MCP 开一个换了 Agent 的子任务，子任务跑完父会话收到回报。
//! 独立聊天也一样，子任务挂在聊天下面、用同一个文件夹；用户只说一句大白话时 Agent 要自己分清交给子 Agent、子任务还是独立会话。
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

/// 同 A1，对 Claude 说。工具是延后加载的，提示里也不教它开完怎么做，这些要它自己从说明和工具描述里拿到。
#[tokio::test]
#[ignore]
async fn claude_chat_opens_a_nested_session_from_plain_words() {
    opens_child(
        "claude-code",
        None,
        "claude-code",
        true,
        "开个嵌套会话做这个任务：只回复 PONG 这个词，不要运行任何工具。结果回来后只回复它的答案。",
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

/// 一句话之后工作去了哪里。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Route {
    /// 自带的子 Agent。
    Native,
    /// 挂在当前任务下面的子任务。
    Subtask,
    /// 独立的顶层会话。
    Session,
    /// 没交给别人，自己回答。
    Here,
    /// 没交给别人，自己建了工作树在里面做。
    OwnWorktree,
}

use Route::{Here, Native, OwnWorktree, Session, Subtask};

/// 用户的说法和该去的地方。说法不能和注入说明里的词重复，否则测的只是 Agent 读到了这个词。
const ROUTING: &[(&str, &[Route], &str)] = &[
    // 这三句只说要能进去看，没说结果要不要回来：子任务和独立会话都满足，就地做不满足。
    // 要盯着和要隔离得是真有活：只回一个词时 Agent 直接答也说得过去，测不出分流。
    ("要盯着", &[Subtask, Session], "这件事单独拎出去跑，我待会要自己进去盯着：看看这个目录里有哪些文件。"),
    ("要插手", &[Subtask, Session], "给这件事单开一条线，别占着你这边，我想随时插手：只回复 PONG 这个词。"),
    ("英文", &[Subtask, Session], "Spin this off on its own so I can keep an eye on it and step in: reply with just PONG."),
    ("要隔离", &[Subtask, OwnWorktree], "这个改动要和当前目录隔开，单独用一个工作树来做：新建 notes.txt，写一行 hello。"),
    ("嵌套", &[Subtask], "开个嵌套会话，只回复 PONG 这个词。"),
    ("裸子 Agent", &[Native], "开个子agent看一下这个目录里有什么文件。"),
    ("英文 subagent", &[Native], "用 subagent 帮我看一下这个目录里有什么文件。"),
    ("叫个 Agent", &[Native], "叫个 agent 帮我看下这个目录里有啥。"),
    ("分头", &[Native], "用子 Agent 分头算一下：17*23 和 19*29，汇总结果给我。"),
    ("新开", &[Session], "新开会话"),
    ("独立", &[Session], "新建一个独立会话，让它只回复 PONG 这个词。"),
    ("另起", &[Session], "另起一条全新的对话处理这个，跟这边不用有关系：只回复 PONG 这个词。"),
    ("并行", &[Here, Native], "同时算这两个，算完告诉我：17*23、19*29。"),
    ("普通问题", &[Here], "17*23 等于多少？直接告诉我。"),
];

/// 给一句话，看 Agent 把工作交给了哪里。回合出错算没有判断，不算选错。
async fn route_of(agent: &str, prompt: &str) -> Result<Route, String> {
    let live = live().await;
    let project = live._dirs.1.path();
    for args in [
        vec!["init"],
        vec!["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"],
    ] {
        assert!(std::process::Command::new("git").args(args).current_dir(project).status().unwrap().success());
    }
    let params = json!({ "agent": agent, "prompt": prompt, "options": {}, "projectId": live.project_id });
    let parent = live.services.dispatch("tasks.create", params).await.unwrap();
    let parent_id = parent["id"].as_str().unwrap().to_string();
    let started = Instant::now();
    let mut settled = 0;
    let verdict = loop {
        if started.elapsed() > Duration::from_secs(240) {
            break Err("等不到结果".to_string());
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
        let tasks = live.tasks().await;
        let task = tasks.iter().find(|task| task["id"] == parent_id).unwrap();
        let events = live.events(task).await;
        if let Some(card) = events.iter().find(|event| event["kind"] == "subtask-offer") {
            break Ok(if card["link"] == "detached" { Session } else { Subtask });
        }
        if events.iter().any(|event| event["kind"] == "subagent") {
            break Ok(Native);
        }
        if tasks.iter().any(|task| task["parentTaskId"] == parent_id) {
            break Ok(Subtask);
        }
        if tasks.len() > 1 {
            break Ok(Session);
        }
        if events.iter().any(|event| event["kind"] == "error") {
            break Err(format!("回合出错：{events:#?}"));
        }
        // 刚起来时状态还是「已完成」，要有回答、并且稳定几次才算这一轮结束。
        settled = if task["attention"]["state"] == "done" && !answers(&events).is_empty() { settled + 1 } else { 0 };
        if settled >= 3 {
            eprintln!("{agent} 自己回答：{:?}", answers(&events).last());
            let worktrees = std::process::Command::new("git").args(["worktree", "list"]).current_dir(project).output().unwrap();
            break Ok(if String::from_utf8_lossy(&worktrees.stdout).lines().count() > 1 { OwnWorktree } else { Here });
        }
    };
    live.services.stop_agents().await;
    verdict
}

/// 全部跑完再报，一次看到这个 Agent 所有选错的说法。
async fn routes(agent: &str, other: &str) {
    let named = format!("让 {other} 帮忙看看这句话有没有错别字：「今天天汽很好」。");
    let mut cases: Vec<(&str, &[Route], &str)> = ROUTING.to_vec();
    cases.push(("点名别的 Agent", &[Subtask], &named));
    let mut wrong = Vec::new();
    for (name, expected, prompt) in cases {
        let verdict = route_of(agent, prompt).await;
        eprintln!("{agent} {name}：该去 {expected:?}，结果 {verdict:?}");
        if !verdict.is_ok_and(|route| expected.contains(&route)) {
            wrong.push(name);
        }
    }
    assert!(wrong.is_empty(), "{agent} 选错：{wrong:?}");
}

#[tokio::test]
#[ignore]
async fn claude_routes_by_what_the_work_needs() {
    routes("claude-code", "Codex").await;
}

#[tokio::test]
#[ignore]
async fn codex_routes_by_what_the_work_needs() {
    routes("codex-cli", "Claude").await;
}

#[tokio::test]
#[ignore]
async fn cursor_routes_by_what_the_work_needs() {
    routes("cursor-agent", "Codex").await;
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
