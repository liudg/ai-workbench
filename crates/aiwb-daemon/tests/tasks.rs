//! 任务和会话走一遍：新建任务、流式输出写库并推送、按 rev 续传、daemon 重启后 resume。
//! Agent 是脚本化的假适配器，不启动真实 CLI。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use aiwb_agents::{
    AgentAdapter, AgentError, AgentSession, AnnotationSink, DiffScopeProvider, DirectoryEntry,
    EventSink, SessionContext, TurnDelivery,
};
use aiwb_core::models::{
    AgentCatalog, AgentCapabilities, AgentKind, PageAnnotation, PromptAnswer, SessionEventBody, SessionStatus,
};
use aiwb_core::DaemonInfo;
use aiwb_daemon::{AdapterFactory, Services};
use aiwb_store::Store;
use async_trait::async_trait;
use serde_json::{json, Value};

#[derive(Default)]
struct Script {
    started: Mutex<Vec<SessionContext>>,
    stopped: Mutex<usize>,
    /// CLI 里开过的会话，导入用。
    listed: Mutex<Vec<DirectoryEntry>>,
    /// 各 Agent 收到的消息原文。
    sent: Mutex<Vec<(AgentKind, String)>>,
}

/// 按 Agent 区分的假适配器：Codex 的新线程叫 `thread-1`，Claude 的叫 `claude-1`。
struct FakeAdapter(Arc<Script>, AgentKind);

struct FakeSession {
    sink: EventSink,
    native: String,
    kind: AgentKind,
    script: Arc<Script>,
}

#[async_trait]
impl AgentAdapter for FakeAdapter {
    fn kind(&self) -> AgentKind {
        self.1
    }

    fn capabilities(&self) -> AgentCapabilities {
        match self.1 {
            AgentKind::ClaudeCode => AgentCapabilities::claude(),
            AgentKind::CodexCli => AgentCapabilities::codex(),
            _ => AgentCapabilities::none(),
        }
    }

    async fn fork_thread(&self, native_id: &str) -> Result<DirectoryEntry, AgentError> {
        Ok(listed(&format!("fork-of-{native_id}"), "", "", 1))
    }

    async fn detect(&self) -> Result<(), AgentError> {
        Ok(())
    }

    fn session_linked(&self) -> bool {
        true
    }

    async fn import_list(&self) -> Result<Vec<DirectoryEntry>, AgentError> {
        if self.1 != AgentKind::CodexCli {
            return Ok(Vec::new());
        }
        Ok(self.0.listed.lock().unwrap().clone())
    }

    async fn import_history(&self, native_id: &str, _cwd: &str) -> Result<Vec<SessionEventBody>, AgentError> {
        if native_id == "broken" {
            return Err(AgentError::Runtime("转录读不了".into()));
        }
        Ok(vec![
            SessionEventBody::StatusChanged {
                status: SessionStatus::Running,
            },
            SessionEventBody::UserMessage {
                text: format!("{native_id} 的问题"),
                images: Vec::new(),
                annotations: 0,
            },
            SessionEventBody::AgentMessage {
                text: format!("{native_id} 的回答"),
                stream_id: None,
                phase: None,
                mode: None,
                dedupe_of: None,
            },
        ])
    }

    async fn start_session(
        &self,
        ctx: SessionContext,
        events: EventSink,
    ) -> Result<Arc<dyn AgentSession>, AgentError> {
        let native = ctx
            .resume_native_id
            .clone()
            .unwrap_or_else(|| match self.1 {
                AgentKind::ClaudeCode => "claude-1".to_string(),
                _ => "thread-1".to_string(),
            });
        self.0.started.lock().unwrap().push(ctx);
        let _ = events.send(SessionEventBody::StatusChanged {
            status: SessionStatus::Completed,
        });
        Ok(Arc::new(FakeSession {
            sink: events,
            native,
            kind: self.1,
            script: self.0.clone(),
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
        self.script.sent.lock().unwrap().push((self.kind, text.clone()));
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

    async fn set_goal(&self, objective: &str) -> Result<(), AgentError> {
        let _ = self.sink.send(SessionEventBody::Goal {
            objective: Some(objective.to_string()),
            status: Some("active".into()),
            token_budget: None,
            tokens_used: None,
            time_used_seconds: None,
        });
        Ok(())
    }

    async fn answer_prompt(&self, _id: &str, _answer: PromptAnswer) -> Result<(), AgentError> {
        Ok(())
    }

    async fn stop(&self) -> Result<(), AgentError> {
        *self.script.stopped.lock().unwrap() += 1;
        Ok(())
    }

    async fn catalog(&self) -> Result<AgentCatalog, AgentError> {
        let mut catalog = AgentCatalog::empty();
        catalog.models.push(
            serde_json::from_value(json!({
                "id": "fake-model",
                "label": "Fake",
                "description": "",
                "is_default": true,
                "default_effort": "",
                "efforts": [],
            }))
            .unwrap(),
        );
        catalog.thread_model = Some(self.native.clone());
        Ok(catalog)
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
    let factory: AdapterFactory = Arc::new(move |agent| Arc::new(FakeAdapter(script.clone(), agent)));
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
            json!({ "projectId": project["id"], "agent": "codex-cli", "prompt": "看看登录\n细节", "options": { "model": "m1" } }),
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
        .dispatch("tasks.create", json!({ "projectId": project["id"], "agent": "codex-cli" }))
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
    store.put_event(task["id"].as_str().unwrap(), &last, false, None).unwrap();

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
        .dispatch("tasks.create", json!({ "projectId": project["id"], "agent": "codex-cli", "worktree": true }))
        .await
        .unwrap();
    let session_id = task["sessions"][0]["id"].clone();
    let worktree = std::path::PathBuf::from(task["workspace"]["path"].as_str().unwrap());
    assert!(worktree.starts_with(dir.path().join("worktrees")));

    // 改的是工作树，主目录不动。
    std::fs::write(worktree.join("calc.py"), "def add(a, b):\n    return a - b\n").unwrap();
    let diff = services
        .dispatch("files.diff", json!({ "sessionId": session_id, "scope": "uncommitted" }))
        .await
        .unwrap();
    assert!(diff.as_str().unwrap().contains("+    return a - b"), "{diff}");
    let file = services
        .dispatch("files.readFile", json!({ "sessionId": session_id, "path": "calc.py" }))
        .await
        .unwrap();
    assert!(file["text"].as_str().unwrap().contains("a - b"));
    let is_git = services
        .dispatch("git.isRepo", json!({ "sessionId": session_id }))
        .await
        .unwrap();
    assert_eq!(is_git, json!(true));
    let scopes = services
        .dispatch("files.diffScopes", json!({ "sessionId": session_id }))
        .await
        .unwrap();
    assert!(scopes.as_array().unwrap().iter().any(|scope| scope["id"] == "uncommitted"));
    assert_eq!(
        std::fs::read_to_string(repo.path().join("calc.py")).unwrap(),
        "def add(a, b):\n    return a + b\n"
    );

    // 文件面板：列目录、按名筛选、搜正文，都在工作树里。
    let listed = services
        .dispatch("files.listDir", json!({ "sessionId": session_id, "path": "" }))
        .await
        .unwrap();
    assert!(listed.as_array().unwrap().iter().any(|entry| entry["path"] == "calc.py"));
    let mut filtered = json!(null);
    for _ in 0..50 {
        filtered = services
            .dispatch("files.filterPaths", json!({ "sessionId": session_id, "query": "calc" }))
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
                "files.searchFiles",
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
        .dispatch("files.readImage", json!({ "sessionId": session_id, "path": "calc.py" }))
        .await;
    assert!(not_image.is_err());

    // 还没建会话时，面板按项目读主目录：主目录没改过，只有 git 的几种范围。
    let main_diff = services
        .dispatch("files.diff", json!({ "projectId": project["id"], "scope": "uncommitted" }))
        .await
        .unwrap();
    assert_eq!(main_diff, json!(""));
    let main_scopes = services
        .dispatch("files.diffScopes", json!({ "projectId": project["id"] }))
        .await
        .unwrap();
    assert!(main_scopes.as_array().unwrap().iter().all(|scope| scope["source"] == "git"));
    let main_file = services
        .dispatch("files.readFile", json!({ "projectId": project["id"], "path": "calc.py" }))
        .await
        .unwrap();
    assert!(main_file["text"].as_str().unwrap().contains("a + b"));

    // 分支跟着会话的工作目录走；删除前能看出工作树有没保存的改动，确认后连目录一起删。
    let branch = services
        .dispatch("git.branch", json!({ "sessionId": session_id }))
        .await
        .unwrap();
    assert_eq!(branch, task["workspace"]["branch"]);
    let main = services
        .dispatch("git.branch", json!({ "projectId": project["id"] }))
        .await
        .unwrap();
    assert_eq!(main, json!("main"));
    let task_id = task["id"].clone();
    let preview = services
        .dispatch("tasks.deletePreview", json!({ "id": task_id }))
        .await
        .unwrap();
    assert_eq!(preview, json!({ "owned": true, "dirty": true }));
    services
        .dispatch(
            "tasks.remove",
            json!({ "id": task_id, "discardWorktree": true, "forceWorktree": true }),
        )
        .await
        .unwrap();
    assert!(!worktree.exists());
}

#[tokio::test]
async fn standalone_chat_gets_a_dated_folder_under_the_task_folder() {
    let dir = tempfile::tempdir().unwrap();
    let chats = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let services = services(Arc::new(Store::open_in_memory().unwrap()), script, dir.path());
    let folder = services
        .dispatch("settings.setTaskFolder", json!({ "path": chats.path().to_string_lossy() }))
        .await
        .unwrap();
    assert!(folder["label"].as_str().unwrap().len() > 0);

    let task = services
        .dispatch("tasks.create", json!({ "agent": "codex-cli", "prompt": "Reply with pong" }))
        .await
        .unwrap();
    assert!(task.get("projectId").is_none());
    assert_eq!(task["workspace"]["kind"], "folder");
    let path = std::path::PathBuf::from(task["workspace"]["path"].as_str().unwrap());
    assert!(path.is_dir());
    assert!(path.ends_with("reply-with-pong"));
    let session_id = task["sessions"][0]["id"].as_str().unwrap().to_string();
    wait_for_answer(&services, &session_id, "收到：Reply with pong").await;

    let worktree = services
        .dispatch("tasks.create", json!({ "agent": "codex-cli", "worktree": true }))
        .await
        .unwrap_err();
    assert!(worktree.contains("不能建工作树"));
    // 删除独立聊天不碰它的文件夹。
    let preview = services
        .dispatch("tasks.deletePreview", json!({ "id": task["id"] }))
        .await
        .unwrap();
    assert_eq!(preview, json!({ "owned": false, "dirty": false }));
    services
        .dispatch("tasks.remove", json!({ "id": task["id"], "discardWorktree": true }))
        .await
        .unwrap();
    assert!(path.is_dir());
}

#[tokio::test]
async fn probe_catalog_starts_a_threadless_cli_once_and_remembers_it() {
    let dir = tempfile::tempdir().unwrap();
    let chats = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let services = services(Arc::new(Store::open_in_memory().unwrap()), script.clone(), dir.path());
    services
        .dispatch("settings.setTaskFolder", json!({ "path": chats.path().to_string_lossy() }))
        .await
        .unwrap();
    let cached = services
        .dispatch("agents.catalog", json!({ "agent": "codex-cli" }))
        .await
        .unwrap();
    assert_eq!(cached, Value::Null);

    let (first, second) = tokio::join!(
        services.dispatch("agents.probeCatalog", json!({ "agent": "codex-cli" })),
        services.dispatch("agents.probeCatalog", json!({ "agent": "codex-cli", "projectId": null })),
    );
    let (first, second) = (first.unwrap(), second.unwrap());
    assert_eq!(first["models"][0]["id"], "fake-model");
    assert_eq!(first, second);
    // 探出来的目录不带线程自己的模型。
    assert!(first.get("thread_model").is_none());

    let started = script.started.lock().unwrap().clone();
    assert_eq!(started.len(), 1);
    assert!(started[0].resume_native_id.is_none());
    assert!(!started[0].flag("persist"));
    assert_eq!(
        std::path::Path::new(&started[0].project_path).canonicalize().unwrap(),
        chats.path().canonicalize().unwrap()
    );
    assert_eq!(*script.stopped.lock().unwrap(), 1);
    let remembered = services
        .dispatch("agents.catalog", json!({ "agent": "codex-cli" }))
        .await
        .unwrap();
    assert_eq!(remembered, first);
}

#[tokio::test]
async fn probe_catalog_refreshes_a_stored_catalog_once_per_launch() {
    let dir = tempfile::tempdir().unwrap();
    let chats = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_in_memory().unwrap());
    let mut stale = AgentCatalog::empty();
    stale.models.push(
        serde_json::from_value(json!({
            "id": "old-model",
            "label": "Old",
            "description": "",
            "is_default": true,
            "default_effort": "",
            "efforts": [],
        }))
        .unwrap(),
    );
    store
        .set_meta("catalog:codex-cli", &serde_json::to_string(&stale).unwrap())
        .unwrap();
    let script = Arc::new(Script::default());
    let services = services(store, script.clone(), dir.path());
    services
        .dispatch("settings.setTaskFolder", json!({ "path": chats.path().to_string_lossy() }))
        .await
        .unwrap();
    // 存下的旧目录先给界面用。
    let cached = services
        .dispatch("agents.catalog", json!({ "agent": "codex-cli" }))
        .await
        .unwrap();
    assert_eq!(cached["models"][0]["id"], "old-model");

    let probed = services
        .dispatch("agents.probeCatalog", json!({ "agent": "codex-cli" }))
        .await
        .unwrap();
    assert_eq!(probed["models"][0]["id"], "fake-model");
    let again = services
        .dispatch("agents.probeCatalog", json!({ "agent": "codex-cli" }))
        .await
        .unwrap();
    assert_eq!(again, probed);
    assert_eq!(script.started.lock().unwrap().len(), 1);
}

fn listed(native_id: &str, cwd: &str, title: &str, updated_at: i64) -> DirectoryEntry {
    DirectoryEntry {
        native_id: native_id.into(),
        cwd: cwd.into(),
        cwd_key: aiwb_core::models::cwd_key(cwd),
        title: title.into(),
        created_at: updated_at - 10,
        updated_at,
        status: SessionStatus::Completed,
        ephemeral: false,
        archived: false,
    }
}

#[tokio::test]
async fn imports_cli_sessions_of_the_project_and_resumes_them() {
    let dir = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let path = project_dir.path().to_string_lossy().to_string();
    let script = Arc::new(Script::default());
    *script.listed.lock().unwrap() = vec![
        listed("old", &path, "旧会话", 1_000),
        listed("new", &path, "", 2_000),
        listed("broken", &path, "坏的", 1_500),
        listed("other", &elsewhere.path().to_string_lossy(), "别的目录", 3_000),
    ];
    let services = services(Arc::new(Store::open_in_memory().unwrap()), script.clone(), dir.path());
    let project = services
        .dispatch("projects.add", json!({ "path": path }))
        .await
        .unwrap();

    // 只列工作目录是项目主目录的，新的在前。
    let list = services
        .dispatch("imports.list", json!({ "projectId": project["id"] }))
        .await
        .unwrap();
    let ids: Vec<_> = list["items"].as_array().unwrap().iter().map(|i| i["nativeId"].as_str().unwrap()).collect();
    assert_eq!(ids, ["new", "broken", "old"]);
    assert!(list["errors"].as_array().unwrap().is_empty());

    let result = services
        .dispatch("imports.run", json!({ "projectId": project["id"], "items": list["items"] }))
        .await
        .unwrap();
    assert_eq!(result["taskIds"].as_array().unwrap().len(), 2);
    assert_eq!(result["failures"][0]["nativeId"], "broken");
    assert_eq!(result["failures"][0]["message"], "转录读不了");

    // 任务保留原来的时间；没有标题时取第一条用户消息；时间线照原样，状态是已完成。
    let tasks = services.dispatch("tasks.list", Value::Null).await.unwrap();
    let tasks = tasks.as_array().unwrap();
    assert_eq!(tasks.len(), 2);
    let new = tasks.iter().find(|t| t["sessions"][0]["nativeId"] == "new").unwrap();
    assert_eq!(new["title"], "new 的问题");
    assert_eq!(new["updatedAt"], 2_000);
    assert_eq!(new["workspace"]["kind"], "root");
    assert_eq!(new["sessions"][0]["status"], "completed");
    let old = tasks.iter().find(|t| t["sessions"][0]["nativeId"] == "old").unwrap();
    assert_eq!(old["title"], "旧会话");
    let session_id = old["sessions"][0]["id"].as_str().unwrap().to_string();
    let feed = services.snapshot(&format!("session:{session_id}"), &json!({})).unwrap();
    let kinds: Vec<_> = events_of(&feed).iter().map(|e| e["kind"].as_str().unwrap().to_string()).collect();
    assert_eq!(kinds, ["user-message", "agent-message"]);
    assert!(script.started.lock().unwrap().is_empty(), "导入不起 CLI");

    // 导入过的不再列出。
    let again = services
        .dispatch("imports.list", json!({ "projectId": project["id"] }))
        .await
        .unwrap();
    let ids: Vec<_> = again["items"].as_array().unwrap().iter().map(|i| i["nativeId"].as_str().unwrap()).collect();
    assert_eq!(ids, ["broken"]);

    // 发消息用 resume 接回原线程，不重放历史。
    services
        .dispatch("sessions.send", json!({ "sessionId": session_id, "text": "接着说" }))
        .await
        .unwrap();
    let feed = wait_for_answer(&services, &session_id, "收到：接着说").await;
    let started = script.started.lock().unwrap();
    assert_eq!(started[0].resume_native_id.as_deref(), Some("old"));
    assert!(started[0].flag("skip_history"));
    assert_eq!(
        events_of(&feed).iter().filter(|e| e["kind"] == "user-message").count(),
        2
    );
}

#[tokio::test]
async fn setting_a_goal_leaves_a_goal_command_in_the_timeline() {
    let dir = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let services = services(Arc::new(Store::open_in_memory().unwrap()), script, dir.path());
    let project = services
        .dispatch("projects.add", json!({ "path": project_dir.path().to_string_lossy() }))
        .await
        .unwrap();
    let task = services
        .dispatch(
            "tasks.create",
            json!({ "projectId": project["id"], "agent": "codex-cli", "goal": "  测试全部通过  " }),
        )
        .await
        .unwrap();
    let session_id = task["sessions"][0]["id"].as_str().unwrap().to_string();
    let topic = format!("session:{session_id}");
    let mut bubbles = Vec::new();
    for _ in 0..100 {
        let feed = services.snapshot(&topic, &json!({})).unwrap();
        bubbles = events_of(&feed)
            .into_iter()
            .filter(|e| e["kind"] == "user-message")
            .map(|e| e["text"].as_str().unwrap().to_string())
            .collect();
        if !bubbles.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(bubbles, ["/goal 测试全部通过"]);
    // 只有目标的任务用目标当标题。
    let tasks = services.dispatch("tasks.list", Value::Null).await.unwrap();
    assert_eq!(tasks[0]["title"], "测试全部通过");

    // 会话里再设一次目标，同样记一条。
    services
        .dispatch("sessions.setGoal", json!({ "sessionId": session_id, "objective": "再加一条" }))
        .await
        .unwrap();
    let feed = services.snapshot(&topic, &json!({})).unwrap();
    assert!(events_of(&feed)
        .iter()
        .any(|e| e["kind"] == "user-message" && e["text"] == "/goal 再加一条"));
    let tasks = services.dispatch("tasks.list", Value::Null).await.unwrap();
    assert_eq!(tasks[0]["title"], "测试全部通过", "已有标题不改");
}

/// 等到时间线里有 `count` 条回答、最后停在已完成。
async fn wait_for_replies(services: &Services, session_id: &str, count: usize) -> Vec<Value> {
    for _ in 0..100 {
        let feed = services
            .snapshot(&format!("session:{session_id}"), &json!({}))
            .unwrap();
        let events = events_of(&feed);
        let replies = events.iter().filter(|e| e["kind"] == "agent-message").count();
        if replies >= count && events.last().is_some_and(|event| event["status"] == "completed") {
            return events;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("没等到第 {count} 条回答");
}

fn last_sent(script: &Script) -> (AgentKind, String) {
    script.sent.lock().unwrap().last().cloned().expect("发过消息")
}

#[tokio::test]
async fn switching_agents_hands_off_the_conversation() {
    let dir = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let services = services(Arc::new(Store::open_in_memory().unwrap()), script.clone(), dir.path());
    let project = services
        .dispatch("projects.add", json!({ "path": project_dir.path().to_string_lossy() }))
        .await
        .unwrap();
    let task = services
        .dispatch(
            "tasks.create",
            json!({ "projectId": project["id"], "agent": "codex-cli", "prompt": "修登录", "options": { "model": "gpt" } }),
        )
        .await
        .unwrap();
    let task_id = task["id"].clone();
    let codex = task["sessions"][0]["id"].as_str().unwrap().to_string();
    wait_for_replies(&services, &codex, 1).await;

    // 换成 Claude：新的一段，第一条消息带上全部前文，气泡只画用户写的。
    let switched = services
        .dispatch(
            "tasks.switchAgent",
            json!({ "taskId": task_id, "agent": "claude-code", "options": { "model": "opus" } }),
        )
        .await
        .unwrap();
    let sessions = switched["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[1]["agent"], "claude-code");
    assert!(sessions[1].get("nativeId").is_none());
    let claude = sessions[1]["id"].as_str().unwrap().to_string();
    let feed = services.snapshot(&format!("session:{claude}"), &json!({})).unwrap();
    let pending = &events_of(&feed)[0];
    assert_eq!(pending["kind"], "handoff");
    assert_eq!(pending["from_agent"], "codex-cli");
    assert_eq!(pending["from_model"], "gpt");
    assert_eq!(pending["to_model"], "opus");
    assert_eq!(pending["strategy"], "full");
    assert!(pending.get("delivered").is_none());

    services
        .dispatch("sessions.send", json!({ "sessionId": claude, "text": "继续" }))
        .await
        .unwrap();
    let events = wait_for_replies(&services, &claude, 1).await;
    let (agent, text) = last_sent(&script);
    assert_eq!(agent, AgentKind::ClaudeCode);
    assert!(text.starts_with("Context handoff (full_thread_summary):\nProvider context handoff."), "{text}");
    assert!(text.contains("[Historical user; user_message; item="));
    assert!(text.contains("\n修登录\n"), "{text}");
    assert!(text.contains("\n收到：修登录"), "{text}");
    assert!(text.ends_with("\n\nUser message:\n继续"), "{text}");
    let bubble = events.iter().find(|e| e["kind"] == "user-message").unwrap();
    assert_eq!(bubble["text"], "继续");
    let delivered = events.iter().find(|e| e["kind"] == "handoff").unwrap();
    assert_eq!(delivered["delivered"], true);
    assert_eq!(delivered["selected"], 2);
    assert!(delivered.get("omitted").is_none());

    // 再发一条就不带前文了。
    services
        .dispatch("sessions.send", json!({ "sessionId": claude, "text": "还有吗" }))
        .await
        .unwrap();
    wait_for_replies(&services, &claude, 2).await;
    assert_eq!(last_sent(&script).1, "还有吗");

    // 换回 Codex：接回原来的线程，只补 Claude 那段。
    let back = services
        .dispatch("tasks.switchAgent", json!({ "taskId": task_id, "agent": "codex-cli" }))
        .await
        .unwrap();
    let sessions = back["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 3);
    assert_eq!(sessions[2]["nativeId"], "thread-1");
    let codex_again = sessions[2]["id"].as_str().unwrap().to_string();

    // 没说话就又换走：这一段不留，回到前面那段 Claude。
    let away = services
        .dispatch("tasks.switchAgent", json!({ "taskId": task_id, "agent": "claude-code" }))
        .await
        .unwrap();
    assert_eq!(away["sessions"].as_array().unwrap().len(), 2);
    assert_eq!(away["sessions"][1]["id"].as_str(), Some(claude.as_str()));
    assert!(services.snapshot(&format!("session:{codex_again}"), &json!({})).is_err());
    let back = services
        .dispatch("tasks.switchAgent", json!({ "taskId": task_id, "agent": "codex-cli" }))
        .await
        .unwrap();
    assert_eq!(back["sessions"].as_array().unwrap().len(), 3);
    assert_eq!(back["sessions"][1]["agent"], "claude-code");
    let codex_again = back["sessions"][2]["id"].as_str().unwrap().to_string();

    services
        .dispatch("sessions.send", json!({ "sessionId": codex_again, "text": "收尾" }))
        .await
        .unwrap();
    wait_for_replies(&services, &codex_again, 1).await;
    let (agent, text) = last_sent(&script);
    assert_eq!(agent, AgentKind::CodexCli);
    assert!(text.starts_with("Context handoff (delta_since_target_last_seen):"), "{text}");
    assert!(text.contains("From: Claude Code. To: Codex CLI."), "{text}");
    assert!(text.contains("\n还有吗\n"), "{text}");
    // Claude 那段的两问两答；Codex 自己那段不再补。
    assert!(text.contains("Selected 4 intact items; omitted 0 items."), "{text}");
    let started = script.started.lock().unwrap();
    assert_eq!(started.last().unwrap().resume_native_id.as_deref(), Some("thread-1"));
}

#[tokio::test]
async fn fork_copies_the_timeline_natively_or_hands_off_to_another_agent() {
    let dir = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let services = services(Arc::new(Store::open_in_memory().unwrap()), script.clone(), dir.path());
    let project = services
        .dispatch("projects.add", json!({ "path": project_dir.path().to_string_lossy() }))
        .await
        .unwrap();
    let task = services
        .dispatch(
            "tasks.create",
            json!({ "projectId": project["id"], "agent": "codex-cli", "prompt": "修登录", "options": { "model": "gpt" } }),
        )
        .await
        .unwrap();
    let source = task["sessions"][0]["id"].as_str().unwrap().to_string();
    let original = wait_for_replies(&services, &source, 1).await;

    // 同一个 Agent：原生分叉，时间线照抄（时间不变），不用交接。
    let forked = services
        .dispatch("tasks.fork", json!({ "taskId": task["id"] }))
        .await
        .unwrap();
    assert_ne!(forked["id"], task["id"]);
    assert_eq!(forked["title"], "修登录");
    assert_eq!(forked["workspace"], task["workspace"]);
    assert_eq!(forked["sessions"][0]["nativeId"], "fork-of-thread-1");
    assert_eq!(forked["sessions"][0]["options"]["model"], "gpt");
    let copy = forked["sessions"][0]["id"].as_str().unwrap();
    let copied = events_of(&services.snapshot(&format!("session:{copy}"), &json!({})).unwrap());
    let kinds: Vec<_> = copied.iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["user-message", "agent-message"]);
    let original_ts: Vec<_> = original
        .iter()
        .filter(|e| e["kind"] != "status-changed")
        .map(|e| e["ts"].clone())
        .collect();
    assert_eq!(copied.iter().map(|e| e["ts"].clone()).collect::<Vec<_>>(), original_ts);

    // 分叉到 Claude：新线程，第一条消息带上全部前文。
    let forked = services
        .dispatch("tasks.fork", json!({ "taskId": task["id"], "agent": "claude-code" }))
        .await
        .unwrap();
    // 原来的一段照抄（还是 Codex，不接原线程），后面另起 Claude 的一段。
    let sessions = forked["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0]["agent"], "codex-cli");
    assert!(sessions[0].get("nativeId").is_none());
    let history = sessions[0]["id"].as_str().unwrap();
    let copied = events_of(&services.snapshot(&format!("session:{history}"), &json!({})).unwrap());
    assert_eq!(copied.len(), 2);
    let session = &sessions[1];
    assert_eq!(session["agent"], "claude-code");
    assert!(session.get("nativeId").is_none());
    assert!(session["options"].get("model").is_none());
    let claude = session["id"].as_str().unwrap().to_string();
    let events = events_of(&services.snapshot(&format!("session:{claude}"), &json!({})).unwrap());
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["kind"], "handoff");
    services
        .dispatch("sessions.send", json!({ "sessionId": claude, "text": "换个思路" }))
        .await
        .unwrap();
    wait_for_replies(&services, &claude, 1).await;
    let (agent, text) = last_sent(&script);
    assert_eq!(agent, AgentKind::ClaudeCode);
    assert!(text.starts_with("Context handoff (full_thread_summary):"), "{text}");
    assert!(text.contains("\n修登录\n"), "{text}");
    assert!(text.ends_with("User message:\n换个思路"), "{text}");
}

#[tokio::test]
async fn idle_session_is_released_and_resumed_on_next_send() {
    let dir = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let services = services(Arc::new(Store::open_in_memory().unwrap()), script.clone(), dir.path());
    let project = services
        .dispatch("projects.add", json!({ "path": project_dir.path().to_string_lossy() }))
        .await
        .unwrap();
    let task = services
        .dispatch(
            "tasks.create",
            json!({ "projectId": project["id"], "agent": "codex-cli", "prompt": "看看登录" }),
        )
        .await
        .unwrap();
    let session_id = task["sessions"][0]["id"].as_str().unwrap().to_string();
    wait_for_answer(&services, &session_id, "收到：看看登录").await;

    assert_eq!(services.release_idle_sessions(Duration::from_secs(3600)).await, 0, "刚用过的不放");
    assert_eq!(services.release_idle_sessions(Duration::ZERO).await, 1);
    assert_eq!(*script.stopped.lock().unwrap(), 1);
    let tasks = services.dispatch("tasks.list", Value::Null).await.unwrap();
    assert_eq!(tasks[0]["sessions"][0]["status"], "completed");

    services
        .dispatch("sessions.send", json!({ "sessionId": session_id, "text": "继续" }))
        .await
        .unwrap();
    let feed = wait_for_answer(&services, &session_id, "收到：继续").await;
    let started = script.started.lock().unwrap();
    assert_eq!(started.len(), 2);
    assert_eq!(started[1].resume_native_id.as_deref(), Some("thread-1"));
    assert!(started[1].flag("skip_history"));
    let seqs: Vec<u64> = events_of(&feed).iter().map(|e| e["seq"].as_u64().unwrap()).collect();
    assert_eq!(seqs, (1..=seqs.len() as u64).collect::<Vec<_>>(), "时间线从库里接着往后排");
}
