//! 任务和会话走一遍：新建任务、流式输出写库并推送、按 rev 续传、daemon 重启后 resume。
//! Agent 是脚本化的假适配器，不启动真实 CLI。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use aiwb_agents::{
    AgentAdapter, AgentError, AgentSession, AnnotationSink, DiffScopeProvider, EventSink,
    SessionContext, TurnDelivery,
};
use aiwb_core::models::{
    AgentCapabilities, AgentKind, PageAnnotation, PromptAnswer, SessionEventBody, SessionStatus,
};
use aiwb_core::DaemonInfo;
use aiwb_daemon::{AdapterFactory, Services};
use aiwb_store::Store;
use async_trait::async_trait;
use serde_json::{json, Value};

#[derive(Default)]
struct Script {
    started: Mutex<Vec<SessionContext>>,
}

struct FakeAdapter(Arc<Script>);

struct FakeSession {
    sink: EventSink,
    native: String,
}

#[async_trait]
impl AgentAdapter for FakeAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::CodexCli
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::codex()
    }

    async fn detect(&self) -> Result<(), AgentError> {
        Ok(())
    }

    fn session_linked(&self) -> bool {
        true
    }

    async fn start_session(
        &self,
        ctx: SessionContext,
        events: EventSink,
    ) -> Result<Arc<dyn AgentSession>, AgentError> {
        let native = ctx
            .resume_native_id
            .clone()
            .unwrap_or_else(|| "thread-1".to_string());
        self.0.started.lock().unwrap().push(ctx);
        let _ = events.send(SessionEventBody::StatusChanged {
            status: SessionStatus::Completed,
        });
        Ok(Arc::new(FakeSession {
            sink: events,
            native,
        }))
    }
}

#[async_trait]
impl DiffScopeProvider for FakeSession {}

#[async_trait]
impl AnnotationSink for FakeSession {
    async fn submit_annotation(&self, _note: PageAnnotation) -> Result<TurnDelivery, AgentError> {
        Ok(TurnDelivery::Started)
    }
}

#[async_trait]
impl AgentSession for FakeSession {
    async fn send_message(&self, text: String) -> Result<(), AgentError> {
        let say = |body| {
            let _ = self.sink.send(body);
        };
        say(SessionEventBody::StatusChanged {
            status: SessionStatus::Running,
        });
        for partial in ["收", "收到："] {
            say(SessionEventBody::AgentMessage {
                text: partial.into(),
                stream_id: Some(format!("m-{text}")),
                phase: None,
                mode: None,
                dedupe_of: None,
            });
        }
        say(SessionEventBody::AgentMessage {
            text: format!("收到：{text}"),
            stream_id: Some(format!("m-{text}")),
            phase: None,
            mode: None,
            dedupe_of: None,
        });
        say(SessionEventBody::StatusChanged {
            status: SessionStatus::Completed,
        });
        Ok(())
    }

    async fn answer_prompt(&self, _id: &str, _answer: PromptAnswer) -> Result<(), AgentError> {
        Ok(())
    }

    async fn stop(&self) -> Result<(), AgentError> {
        Ok(())
    }

    fn native_id(&self) -> Option<String> {
        Some(self.native.clone())
    }
}

fn services(store: Arc<Store>, script: Arc<Script>, data_dir: &std::path::Path) -> Services {
    let info = DaemonInfo {
        version: "test".into(),
        build: String::new(),
        pid: 1,
        port: 0,
        token: "t".into(),
    };
    let factory: AdapterFactory = Arc::new(move |_| Arc::new(FakeAdapter(script.clone())));
    Services::with_adapters(store, info, data_dir.to_path_buf(), factory)
}

/// 快照里没有事件时不带 `events`。
fn events_of(feed: &Value) -> Vec<Value> {
    feed["events"].as_array().cloned().unwrap_or_default()
}

/// 等到时间线里出现最终回答。
async fn wait_for_answer(services: &Services, session_id: &str, text: &str) -> Value {
    for _ in 0..100 {
        let feed = services
            .snapshot(&format!("session:{session_id}"), &json!({}))
            .unwrap();
        let events = events_of(&feed);
        let done = events
            .iter()
            .any(|event| event["kind"] == "agent-message" && event["text"] == text)
            && events.last().is_some_and(|event| event["status"] == "completed");
        if done {
            return feed;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("没等到回答：{text}");
}

#[tokio::test]
async fn task_runs_streams_and_resumes_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db.sqlite");
    let script = Arc::new(Script::default());

    let first = services(Arc::new(Store::open(&db).unwrap()), script.clone(), dir.path());
    let project = first
        .dispatch("projects.add", json!({ "path": project_dir.path().to_string_lossy() }))
        .await
        .unwrap();
    let mut rx = first.hub().receiver();
    let task = first
        .dispatch(
            "tasks.create",
            json!({ "projectId": project["id"], "prompt": "看看登录\n细节", "options": { "model": "m1" } }),
        )
        .await
        .unwrap();
    let session_id = task["sessions"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(task["workspace"]["kind"], "root");

    let feed = wait_for_answer(&first, &session_id, "收到：看看登录\n细节").await;
    let events = events_of(&feed);
    // 流式的三段并成一条，用户消息在里面，seq 连续。
    let answers: Vec<_> = events.iter().filter(|e| e["kind"] == "agent-message").collect();
    assert_eq!(answers.len(), 1);
    assert!(events.iter().any(|e| e["kind"] == "user-message" && e["text"] == "看看登录\n细节"));
    let seqs: Vec<u64> = events.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
    assert_eq!(seqs, (1..=seqs.len() as u64).collect::<Vec<_>>());

    // 推送里能看到同一条消息被覆盖：seq 相同、rev 变大。
    let topic = format!("session:{session_id}");
    let mut revs_of_answer = Vec::new();
    while let Ok(envelope) = rx.try_recv() {
        if envelope.topic != topic {
            continue;
        }
        for event in envelope.data["events"].as_array().into_iter().flatten() {
            if event["kind"] == "agent-message" {
                revs_of_answer.push((event["seq"].as_u64().unwrap(), event["rev"].as_u64().unwrap()));
            }
        }
    }
    assert_eq!(revs_of_answer.len(), 3);
    assert!(revs_of_answer.iter().all(|(seq, _)| *seq == revs_of_answer[0].0));
    assert!(revs_of_answer.windows(2).all(|pair| pair[0].1 < pair[1].1));

    // 断线续传：只补 rev 之后的。
    let last_rev = events.iter().map(|e| e["rev"].as_u64().unwrap()).max().unwrap();
    let tail = first.snapshot(&topic, &json!({ "fromRev": last_rev - 1 })).unwrap();
    assert_eq!(events_of(&tail).len(), 1);
    assert!(tail.get("reset").is_none());

    // 标题取自第一条消息的首行；原生 id 写进数据库。
    let tasks = first.dispatch("tasks.list", Value::Null).await.unwrap();
    assert_eq!(tasks[0]["title"], "看看登录");
    assert_eq!(tasks[0]["sessions"][0]["nativeId"], "thread-1");
    assert_eq!(tasks[0]["sessions"][0]["options"]["model"], "m1");
    drop(first);

    // daemon 重启：同一个库，新进程。发送时用 resume 接回线程，不重放历史。
    let second = services(Arc::new(Store::open(&db).unwrap()), script.clone(), dir.path());
    second.settle_interrupted().unwrap();
    second
        .dispatch("sessions.send", json!({ "sessionId": session_id, "text": "继续" }))
        .await
        .unwrap();
    let feed = wait_for_answer(&second, &session_id, "收到：继续").await;
    let started = script.started.lock().unwrap();
    assert_eq!(started.len(), 2);
    assert_eq!(started[1].resume_native_id.as_deref(), Some("thread-1"));
    assert!(started[1].flag("skip_history"));
    let events = events_of(&feed);
    assert_eq!(
        events.iter().filter(|e| e["kind"] == "user-message").count(),
        2,
        "重启前的时间线还在，新回合接在后面"
    );
    let seqs: Vec<u64> = events.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
    assert_eq!(seqs, (1..=seqs.len() as u64).collect::<Vec<_>>());
}

#[tokio::test]
async fn restart_marks_running_sessions_stopped() {
    let dir = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db.sqlite");
    let script = Arc::new(Script::default());
    let first = services(Arc::new(Store::open(&db).unwrap()), script.clone(), dir.path());
    let project = first
        .dispatch("projects.add", json!({ "path": project_dir.path().to_string_lossy() }))
        .await
        .unwrap();
    let task = first
        .dispatch("tasks.create", json!({ "projectId": project["id"] }))
        .await
        .unwrap();
    let session_id = task["sessions"][0]["id"].as_str().unwrap().to_string();
    // 假装上次退出时回合还在跑。
    first
        .dispatch("sessions.send", json!({ "sessionId": session_id, "text": "/status" }))
        .await
        .unwrap();
    wait_for_answer(&first, &session_id, "收到：/status").await;
    let store = Store::open(&db).unwrap();
    drop(first);
    let running = SessionEventBody::StatusChanged {
        status: SessionStatus::Running,
    };
    let events = store.events_since(&session_id, 0).unwrap();
    let mut last = events.last().unwrap().clone();
    last.event.seq += 1;
    last.rev += 1;
    last.event.body = running;
    store.put_event(task["id"].as_str().unwrap(), &last, false).unwrap();

    let second = services(Arc::new(store), script, dir.path());
    second.settle_interrupted().unwrap();
    let tasks = second.dispatch("tasks.list", Value::Null).await.unwrap();
    assert_eq!(tasks[0]["sessions"][0]["status"], "stopped");
    // 斜杠命令不画用户气泡。
    let feed = second.snapshot(&format!("session:{session_id}"), &json!({})).unwrap();
    assert!(!events_of(&feed).iter().any(|e| e["kind"] == "user-message"));
}

fn git(dir: &std::path::Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .expect("git");
    assert!(status.success(), "{args:?}");
}

#[tokio::test]
async fn diff_file_and_git_follow_the_task_worktree() {
    let dir = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "-q", "-b", "main"]);
    std::fs::write(repo.path().join("calc.py"), "def add(a, b):\n    return a + b\n").unwrap();
    git(repo.path(), &["add", "."]);
    git(
        repo.path(),
        &["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"],
    );
    let script = Arc::new(Script::default());
    let services = services(Arc::new(Store::open_in_memory().unwrap()), script, dir.path());
    let project = services
        .dispatch("projects.add", json!({ "path": repo.path().to_string_lossy() }))
        .await
        .unwrap();
    let task = services
        .dispatch("tasks.create", json!({ "projectId": project["id"], "worktree": true }))
        .await
        .unwrap();
    let session_id = task["sessions"][0]["id"].clone();
    let worktree = std::path::PathBuf::from(task["workspace"]["path"].as_str().unwrap());
    assert!(worktree.starts_with(dir.path().join("worktrees")));

    // 改的是工作树，主目录不动。
    std::fs::write(worktree.join("calc.py"), "def add(a, b):\n    return a - b\n").unwrap();
    let diff = services
        .dispatch("sessions.diff", json!({ "sessionId": session_id, "scope": "uncommitted" }))
        .await
        .unwrap();
    assert!(diff.as_str().unwrap().contains("+    return a - b"), "{diff}");
    let file = services
        .dispatch("sessions.readFile", json!({ "sessionId": session_id, "path": "calc.py" }))
        .await
        .unwrap();
    assert!(file["text"].as_str().unwrap().contains("a - b"));
    let is_git = services
        .dispatch("sessions.isGit", json!({ "sessionId": session_id }))
        .await
        .unwrap();
    assert_eq!(is_git, json!(true));
    let scopes = services
        .dispatch("sessions.diffScopes", json!({ "sessionId": session_id }))
        .await
        .unwrap();
    assert!(scopes.as_array().unwrap().iter().any(|scope| scope["id"] == "uncommitted"));
    assert_eq!(
        std::fs::read_to_string(repo.path().join("calc.py")).unwrap(),
        "def add(a, b):\n    return a + b\n"
    );

    // 文件面板：列目录、按名筛选、搜正文，都在工作树里。
    let listed = services
        .dispatch("sessions.listDir", json!({ "sessionId": session_id, "path": "" }))
        .await
        .unwrap();
    assert!(listed.as_array().unwrap().iter().any(|entry| entry["path"] == "calc.py"));
    let mut filtered = json!(null);
    for _ in 0..50 {
        filtered = services
            .dispatch("sessions.filterPaths", json!({ "sessionId": session_id, "query": "calc" }))
            .await
            .unwrap();
        if filtered["ready"] == json!(true) {
            break;
        }
    }
    assert_eq!(filtered["paths"], json!(["calc.py"]));
    let mut found = json!(null);
    for _ in 0..200 {
        found = services
            .dispatch(
                "sessions.searchFiles",
                json!({ "sessionId": session_id, "query": "a - b", "mask": "", "searchId": 1 }),
            )
            .await
            .unwrap();
        if found["done"] == json!(true) {
            break;
        }
    }
    assert!(
        found["hits"].as_array().unwrap().iter().any(|hit| hit["path"] == "calc.py" && hit["line"] == 2),
        "{found}"
    );
    let not_image = services
        .dispatch("sessions.readImage", json!({ "sessionId": session_id, "path": "calc.py" }))
        .await;
    assert!(not_image.is_err());
}
