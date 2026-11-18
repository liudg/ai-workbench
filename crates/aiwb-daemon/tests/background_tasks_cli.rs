//! 真实 CLI 跑后台任务：Claude 的 `local_bash`、Codex 的后台终端。主回合完了会话仍算在做，任务跑完才算完成；
//! Claude 跑完后被唤醒自己开的一轮要有回合起点和运行中；`sessions.stopBackgroundTask` 能单独停掉一个。
//! 要本机装好并登录 Codex 和 Claude Code，会花一点额度：
//! `cargo test -p aiwb-daemon --test background_tasks_cli -- --ignored --nocapture --test-threads=1`

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

fn session_id(task: &Value) -> String {
    task["sessions"].as_array().unwrap().last().unwrap()["id"].as_str().unwrap().to_string()
}

fn events(services: &Services, task: &Value) -> Vec<Value> {
    let feed = services.snapshot(&format!("session:{}", session_id(task)), &json!({})).unwrap();
    feed["events"].as_array().cloned().unwrap_or_default()
}

fn background(events: &[Value]) -> Vec<Value> {
    events.iter().filter(|event| event["kind"] == "background-task").cloned().collect()
}

fn statuses(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter(|event| event["kind"] == "status-changed")
        .filter_map(|event| event["status"].as_str())
        .map(str::to_string)
        .collect()
}

async fn wait_for(services: &Services, id: &str, what: &str, done: impl Fn(&Value, &[Value]) -> bool) -> (Value, Vec<Value>) {
    let started = Instant::now();
    loop {
        let task = task(services, id).await;
        let events = events(services, &task);
        let status = events.iter().rev().find(|event| event["kind"] == "status-changed")
            .and_then(|event| event["status"].as_str());
        if let Some(status @ ("failed" | "stopped")) = status {
            let reason = events.iter().rev().find(|event| event["kind"] == "error")
                .and_then(|event| event["message"].as_str()).unwrap_or("");
            panic!("等待「{what}」时会话已结束（{status}） {reason}");
        }
        if done(&task, &events) {
            return (task, events);
        }
        if started.elapsed() > Duration::from_secs(600) {
            panic!("等不到：{what}\n{}", serde_json::to_string_pretty(&events).unwrap());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

struct Run {
    services: Arc<Services>,
    id: String,
    _db: tempfile::TempDir,
    _project: tempfile::TempDir,
}

async fn open(agent: &str, model: Option<&str>, prompt: &str) -> Run {
    let db = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let services = services(db.path()).await;
    let project = services
        .dispatch("projects.add", json!({ "path": project_dir.path().to_string_lossy() }))
        .await
        .unwrap();
    let mut options = json!({});
    if let Some(model) = model {
        options["model"] = json!(model);
    }
    let task = services
        .dispatch("tasks.create", json!({ "projectId": project["id"], "agent": agent, "prompt": prompt, "options": options }))
        .await
        .unwrap();
    Run { services, id: task["id"].as_str().unwrap().to_string(), _db: db, _project: project_dir }
}

impl Run {
    /// 主回合完了、后台任务还在跑：会话仍算在做，任务对得上工具卡片。返回那条任务。
    async fn running_after_turn(&self) -> Value {
        let (task, events) = wait_for(&self.services, &self.id, "主回合完了、后台任务还在跑", |_, events| {
            statuses(events).last().map(String::as_str) == Some("completed")
                && background(events).iter().any(|task| task["status"] == "running")
        })
        .await;
        assert_eq!(task["attention"]["state"], "working", "{:#?}", task["attention"]);
        let running = background(&events).into_iter().find(|task| task["status"] == "running").unwrap();
        eprintln!("后台任务：{}", serde_json::to_string_pretty(&running).unwrap());
        let card = running["tool_call_id"].as_str().expect("要对上工具卡片");
        assert!(
            events.iter().any(|event| event["kind"] == "tool-call" && event["stream_id"] == card),
            "{card} 不是时间线里的工具卡片"
        );
        running
    }

    /// 后台任务都结束、会话完成。返回这时的时间线。
    async fn settled(&self) -> Vec<Value> {
        wait_for(&self.services, &self.id, "后台任务结束、会话完成", |task, events| {
            task["attention"]["state"] == "done" && background(events).iter().all(|task| task["status"] != "running")
        })
        .await
        .1
    }

    /// 逐个停掉还在跑的后台任务（模型偶尔会把同一条命令起两次）。
    async fn stop_all(&self) {
        let task = task(&self.services, &self.id).await;
        for running in background(&events(&self.services, &task)).iter().filter(|task| task["status"] == "running") {
            self.services
                .dispatch(
                    "sessions.stopBackgroundTask",
                    json!({ "sessionId": session_id(&task), "taskId": running["task_id"] }),
                )
                .await
                .unwrap();
        }
        let tasks = background(&self.settled().await);
        assert!(tasks.iter().all(|task| task["status"] == "stopped"), "{tasks:#?}");
    }
}

/// Claude：后台命令跑完后，CLI 自己开的那一轮有新的回合起点，先运行中再完成。
#[tokio::test]
#[ignore]
async fn claude_background_command_runs_and_wakes_a_turn() {
    let run = open(
        "claude-code",
        Some("haiku"),
        "Use the Bash tool with run_in_background set to true to run exactly: sleep 20 && echo BG-DONE . \
         Do not wait for it or check on it. Then end your turn replying only: started.",
    )
    .await;
    let running = run.running_after_turn().await;
    assert_eq!(running["task_type"], "local_bash");
    let anchors = |events: &[Value]| events.iter().filter(|event| event["kind"] == "turn-anchor").count();
    let runs = |events: &[Value]| statuses(events).iter().filter(|status| *status == "running").count();
    let before = events(&run.services, &task(&run.services, &run.id).await);
    let (anchors_before, runs_before) = (anchors(&before), runs(&before));
    // 后台任务结束时会话会短暂算完成，被唤醒的那一轮可能还没开始：要等到新回合出现、报过运行中并且跑完。
    let (_, events) = wait_for(&run.services, &run.id, "被唤醒的一轮开始并完成", |task, events| {
        task["attention"]["state"] == "done"
            && background(events).iter().all(|task| task["status"] != "running")
            && anchors(events) > anchors_before
            && runs(events) > runs_before
            && statuses(events).last().map(String::as_str) == Some("completed")
    })
    .await;
    let tasks = background(&events);
    assert!(tasks.iter().all(|task| task["status"] == "completed"), "{tasks:#?}");
    let statuses = statuses(&events);
    eprintln!("状态：{statuses:?}");
    assert!(statuses.ends_with(&["running".to_string(), "completed".to_string()]), "{statuses:?}");
    run.services.stop_agents().await;
}

#[tokio::test]
#[ignore]
async fn claude_background_command_can_be_stopped() {
    let run = open(
        "claude-code",
        Some("haiku"),
        "Use the Bash tool with run_in_background set to true to run exactly: sleep 300 && echo BG-DONE . \
         Do not wait for it or check on it. Then end your turn replying only: started.",
    )
    .await;
    run.running_after_turn().await;
    run.stop_all().await;
    run.services.stop_agents().await;
}

fn codex_prompt(seconds: u32) -> String {
    format!(
        "Run this exact shell command in a terminal session: Start-Sleep -Seconds {seconds}; Write-Output BG-DONE . \
         Use a yield time of 1000 ms so it keeps running; do not poll it, do not wait for it. \
         Immediately end your turn by replying only: started."
    )
}

#[tokio::test]
#[ignore]
async fn codex_background_terminal_runs_to_the_end() {
    let run = open("codex-cli", None, &codex_prompt(30)).await;
    let running = run.running_after_turn().await;
    assert_eq!(running["task_type"], "terminal");
    let tasks = background(&run.settled().await);
    assert!(tasks.iter().all(|task| task["status"] == "completed" && task["exit_code"] == 0), "{tasks:#?}");
    run.services.stop_agents().await;
}

#[tokio::test]
#[ignore]
async fn codex_background_terminal_can_be_stopped() {
    let run = open("codex-cli", None, &codex_prompt(300)).await;
    run.running_after_turn().await;
    run.stop_all().await;
    run.services.stop_agents().await;
}
