//! 真实 CLI 跑 Agent 自带的子 Agent：并行派两个，卡片状态、结果、步骤要对，子 Agent 的话不进主时间线；
//! Claude 再派一个后台的，主回合完了会话仍算在做，子 Agent 跑完才算完成；换一个 daemon 打开同一个库，时间线不变。
//! 要本机装好并登录 Codex 和 Claude Code，会花一点额度：
//! `cargo test -p aiwb-daemon --test subagents_cli -- --ignored --nocapture --test-threads=1`

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use aiwb_core::DaemonInfo;
use aiwb_daemon::{router, Services};
use aiwb_store::Store;
use serde_json::{json, Value};

async fn services(db: &Path) -> Arc<Services> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let info = DaemonInfo {
        version: "test".into(),
        build: String::new(),
        pid: std::process::id(),
        port,
        token: "t".into(),
    };
    let store = Arc::new(Store::open(&db.join("db.sqlite")).unwrap());
    let services = Arc::new(Services::new(store, info, db.to_path_buf()));
    let app = router(services.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    services
}

async fn task(services: &Services, id: &str) -> Value {
    let tasks = services.dispatch("tasks.list", json!({})).await.unwrap();
    tasks.as_array().unwrap().iter().find(|task| task["id"] == id).unwrap().clone()
}

fn events(services: &Services, task: &Value) -> Vec<Value> {
    let session = task["sessions"].as_array().unwrap().last().unwrap()["id"].as_str().unwrap().to_string();
    let feed = services.snapshot(&format!("session:{session}"), &json!({})).unwrap();
    feed["events"].as_array().cloned().unwrap_or_default()
}

fn cards(events: &[Value]) -> Vec<Value> {
    events.iter().filter(|event| event["kind"] == "subagent").cloned().collect()
}

async fn wait_for(services: &Services, id: &str, what: &str, done: impl Fn(&Value, &[Value]) -> bool) -> (Value, Vec<Value>) {
    let started = Instant::now();
    loop {
        let task = task(services, id).await;
        let events = events(services, &task);
        if done(&task, &events) {
            return (task, events);
        }
        if started.elapsed() > Duration::from_secs(600) {
            panic!("等不到：{what}\n{}", serde_json::to_string_pretty(&events).unwrap());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn create(services: &Services, project: &str, agent: &str, model: Option<&str>, prompt: &str) -> String {
    let mut options = json!({});
    if let Some(model) = model {
        options["model"] = json!(model);
    }
    let task = services
        .dispatch("tasks.create", json!({ "projectId": project, "agent": agent, "prompt": prompt, "options": options }))
        .await
        .unwrap();
    task["id"].as_str().unwrap().to_string()
}

/// 并行两个子 Agent：两张卡都完成，结果对，各自有步骤，主时间线里没有子 Agent 的话。
async fn parallel(agent: &str, model: Option<&str>) {
    let db = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let services = services(db.path()).await;
    let project = services
        .dispatch("projects.add", json!({ "path": project_dir.path().to_string_lossy() }))
        .await
        .unwrap();
    let project = project["id"].as_str().unwrap().to_string();
    let prompt = "Spawn two sub-agents in parallel: one runs the shell command `echo PING` and replies with exactly its output, \
                  the other replies with exactly the word PONG without using any tools. Wait for both, then reply with both words.";
    let id = create(&services, &project, agent, model, prompt).await;
    let (_, events) = wait_for(&services, &id, "两个子 Agent 跑完、主回合答完", |task, events| {
        task["attention"]["state"] == "done"
            && cards(events).len() >= 2
            && cards(events).iter().all(|card| card["status"] != "running")
    })
    .await;
    let cards = cards(&events);
    eprintln!("{agent} 卡片：{}", serde_json::to_string_pretty(&cards).unwrap());
    assert!(cards.iter().all(|card| card["status"] == "completed"), "{cards:#?}");
    let results: Vec<String> = cards.iter().map(|card| card["result"].as_str().unwrap_or("").to_string()).collect();
    assert!(results.iter().any(|text| text.contains("PING")), "{results:?}");
    assert!(results.iter().any(|text| text.contains("PONG")), "{results:?}");
    // 跑了命令的那个有自己的步骤。不用工具的那个，Claude 不一定把它的回答推出来，结果在卡片上。
    let ping = cards
        .iter()
        .find(|card| card["result"].as_str().unwrap_or("").contains("PING"))
        .unwrap();
    let id = ping["subagent_id"].as_str().unwrap();
    assert!(
        events.iter().any(|event| event["kind"] == "subagent-step"
            && event["subagent_id"] == id
            && event["step"]["kind"] == "tool-call"),
        "{id} 没有命令步骤"
    );
    // 子 Agent 只回一个词；主时间线里不该有一条只说这个词的回答。
    let main_answers: Vec<&str> = events
        .iter()
        .filter(|event| event["kind"] == "agent-message")
        .filter_map(|event| event["text"].as_str())
        .collect();
    eprintln!("{agent} 主时间线回答：{main_answers:?}");
    assert!(!main_answers.iter().any(|text| text.trim() == "PING" || text.trim() == "PONG"), "{main_answers:?}");
    assert!(!events.iter().any(|event| event["kind"] == "tool-call" && event["name"] == "Agent"));
    services.stop_agents().await;
}

#[tokio::test]
#[ignore]
async fn claude_parallel_subagents() {
    parallel("claude-code", Some("haiku")).await;
}

#[tokio::test]
#[ignore]
async fn codex_parallel_subagents() {
    parallel("codex-cli", None).await;
}

/// Claude 后台子 Agent：主回合先完，会话仍在做；子 Agent 跑完后完成。换个 daemon 打开同一个库，卡片不变。
#[tokio::test]
#[ignore]
async fn claude_background_subagent_keeps_the_session_working() {
    let db = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let services = services(db.path()).await;
    let project = services
        .dispatch("projects.add", json!({ "path": project_dir.path().to_string_lossy() }))
        .await
        .unwrap();
    let project = project["id"].as_str().unwrap().to_string();
    let id = create(
        &services,
        &project,
        "claude-code",
        Some("haiku"),
        "Use the Agent tool with run_in_background true to launch one sub-agent that runs the shell command \
         `sleep 20 && echo BG` and replies with its output. Do not wait for it: say 'launched' and end your turn.",
    )
    .await;
    let (task, _) = wait_for(&services, &id, "主回合完了、后台子 Agent 还在跑", |_, events| {
        let main_done = events
            .iter()
            .rev()
            .find(|event| event["kind"] == "status-changed")
            .is_some_and(|event| event["status"] == "completed");
        main_done && cards(events).iter().any(|card| card["status"] == "running" && card["background"] == true)
    })
    .await;
    assert_eq!(task["attention"]["state"], "working", "{:#?}", task["attention"]);
    let (task, finished) = wait_for(&services, &id, "后台子 Agent 跑完", |task, events| {
        task["attention"]["state"] == "done" && cards(events).iter().all(|card| card["status"] == "completed")
    })
    .await;
    let card = cards(&finished).pop().unwrap();
    eprintln!("后台卡片：{}", serde_json::to_string_pretty(&card).unwrap());
    assert!(card["result"].as_str().unwrap_or("").contains("BG"), "{card:#?}");
    services.stop_agents().await;
    drop(services);

    let reopened = self::services(db.path()).await;
    let again = events(&reopened, &task);
    assert_eq!(cards(&again), cards(&finished));
}
