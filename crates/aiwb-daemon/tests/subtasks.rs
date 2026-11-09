//! 嵌套任务走一遍：Agent 经 `/mcp` 开子任务、读子任务、追加消息，子任务跑完结果回到父会话。
//! Agent 是脚本化的假适配器，MCP 走真实的 HTTP。
//!
//! 假会话收到的消息里带 `[hold]` 时回合一直开着（模拟 Agent 正在调工具），带 `[ask]` 时停在等审批，
//! 否则回一句「收到：…」就结束。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aiwb_agents::{
    AgentAdapter, AgentError, AgentSession, AnnotationSink, DiffScopeProvider, EventSink, SessionContext,
    TurnDelivery, WorkbenchMcp,
};
use aiwb_core::models::{
    AgentCapabilities, AgentKind, PageAnnotation, PermissionMenu, PermissionProfileOption, PromptAnswer, PromptKind,
    SessionEventBody, SessionStatus, SubagentCard, SubagentStatus,
};
use aiwb_core::DaemonInfo;
use aiwb_daemon::{router, AdapterFactory, Services};
use aiwb_store::Store;
use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 不分叉的会话必须带的背景，够 80 字。
const BACKGROUND: &str = "这是发起会话写给新会话的背景，交代整体目标、已经定下的决定和约束，以及这一块工作在整件事里的位置，读的人没有看过发起会话的对话，所以要写得足够完整，至少八十个字才算数。";

#[derive(Default)]
struct Script {
    /// 每次拉起进程时的原生 id 和上下文。
    started: Mutex<Vec<(String, SessionContext)>>,
    sinks: Mutex<HashMap<String, EventSink>>,
    /// 每个原生会话收到的消息原文。
    sent: Mutex<Vec<(String, String)>>,
    startup_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
    fail_start: std::sync::atomic::AtomicBool,
    stopped: Mutex<Vec<String>>,
}

struct FakeAdapter(Arc<Script>, AgentKind);

struct FakeSession {
    native: String,
    sink: EventSink,
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
            _ => AgentCapabilities::codex(),
        }
    }

    async fn detect(&self) -> Result<(), AgentError> {
        Ok(())
    }

    fn session_linked(&self) -> bool {
        matches!(self.1, AgentKind::ClaudeCode | AgentKind::CodexCli)
    }

    fn takes_workbench_mcp(&self) -> bool {
        true
    }

    async fn fork_thread(&self, native_id: &str, cwd: Option<&str>) -> Result<aiwb_agents::DirectoryEntry, AgentError> {
        Ok(aiwb_agents::DirectoryEntry {
            native_id: format!("fork-of-{native_id}"),
            cwd: cwd.unwrap_or_default().into(),
            cwd_key: String::new(),
            title: String::new(),
            created_at: 1,
            updated_at: 1,
            status: SessionStatus::Completed,
            ephemeral: false,
            archived: false,
        })
    }

    /// Codex 四档都有，Claude 没有只读和替我批准。
    fn draft_permission_menu(&self) -> PermissionMenu {
        let ids: &[&str] = match self.1 {
            AgentKind::CodexCli => &["read-only", "ask", "approve-for-me", "full"],
            _ => &["ask", "full"],
        };
        let mut menu = PermissionMenu::unsupported();
        menu.presets = ids
            .iter()
            .map(|id| PermissionProfileOption {
                id: id.to_string(),
                label: id.to_string(),
                description: String::new(),
                disabled_reason: None,
                caution: false,
                allows_extras: false,
            })
            .collect();
        menu
    }

    async fn start_session(&self, ctx: SessionContext, events: EventSink) -> Result<Arc<dyn AgentSession>, AgentError> {
        let native = ctx
            .resume_native_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        self.0.started.lock().unwrap().push((native.clone(), ctx));
        self.0.sinks.lock().unwrap().insert(native.clone(), events.clone());
        let _ = events.send(SessionEventBody::StatusChanged {
            status: SessionStatus::Completed,
        });
        let gate = self.0.startup_gate.lock().unwrap().clone();
        if let Some(gate) = gate { gate.acquire().await.unwrap().forget(); }
        if self.0.fail_start.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(AgentError::Closed);
        }
        Ok(Arc::new(FakeSession {
            native,
            sink: events,
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
        self.script.sent.lock().unwrap().push((self.native.clone(), text.clone()));
        let say = |body| {
            let _ = self.sink.send(body);
        };
        say(SessionEventBody::StatusChanged {
            status: SessionStatus::Running,
        });
        if text.contains("[hold]") {
            return Ok(());
        }
        if text.contains("[ask]") {
            say(SessionEventBody::Prompt {
                prompt_id: "p1".into(),
                prompt_kind: PromptKind::Approval,
                question: "运行 rm".into(),
                options: Vec::new(),
                questions: Vec::new(),
                header: String::new(),
                subtitle: String::new(),
                body: String::new(),
                body_kind: String::new(),
                reason: String::new(),
            });
            say(SessionEventBody::StatusChanged {
                status: SessionStatus::NeedsInput,
            });
            return Ok(());
        }
        say(SessionEventBody::AgentMessage {
            text: format!("收到：{text}"),
            stream_id: None,
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
        self.script.stopped.lock().unwrap().push(self.native.clone());
        Ok(())
    }

    fn native_id(&self) -> Option<String> {
        Some(self.native.clone())
    }
}

struct Harness {
    services: Arc<Services>,
    script: Arc<Script>,
    port: u16,
    project_id: String,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}

async fn harness() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let script = Arc::new(Script::default());
    let factory: AdapterFactory = {
        let script = script.clone();
        Arc::new(move |agent| Arc::new(FakeAdapter(script.clone(), agent)))
    };
    let info = DaemonInfo {
        version: "test".into(),
        build: String::new(),
        pid: 1,
        port,
        token: "t".into(),
    };
    let store = Arc::new(Store::open(&dir.path().join("db.sqlite")).unwrap());
    let services = Arc::new(Services::with_adapters(store, info, dir.path().to_path_buf(), factory));
    services.start_subtask_reports();
    let app = router(services.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let project = services
        .dispatch("projects.add", json!({ "path": project_dir.path().to_string_lossy() }))
        .await
        .unwrap();
    Harness {
        services,
        script,
        port,
        project_id: project["id"].as_str().unwrap().to_string(),
        _dirs: (dir, project_dir),
    }
}

impl Harness {
    async fn create(&self, agent: &str, prompt: &str, options: Value) -> Value {
        self.services
            .dispatch(
                "tasks.create",
                json!({ "projectId": self.project_id, "agent": agent, "prompt": prompt, "options": options }),
            )
            .await
            .unwrap()
    }

    async fn task(&self, id: &str) -> Value {
        let tasks = self.services.dispatch("tasks.list", json!({})).await.unwrap();
        tasks.as_array().unwrap().iter().find(|task| task["id"] == id).cloned().unwrap()
    }

    async fn children(&self, parent: &str) -> Vec<Value> {
        let tasks = self.services.dispatch("tasks.list", json!({})).await.unwrap();
        tasks
            .as_array()
            .unwrap()
            .iter()
            .filter(|task| task["parentTaskId"] == parent)
            .cloned()
            .collect()
    }

    /// 等到任务现在用的会话进入这个注意力状态，返回会话 id。
    async fn wait_state(&self, task_id: &str, state: &str) -> String {
        for _ in 0..200 {
            let task = self.task(task_id).await;
            if task["attention"]["state"] == state {
                return task["sessions"].as_array().unwrap().last().unwrap()["id"].as_str().unwrap().to_string();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("任务 {task_id} 没到 {state}：{}", self.task(task_id).await);
    }

    /// 这个原生会话拉起时拿到的工作台 MCP。
    fn mcp_of(&self, native: &str) -> Option<WorkbenchMcp> {
        let started = self.script.started.lock().unwrap();
        started.iter().rev().find(|(id, _)| id == native).and_then(|(_, ctx)| ctx.workbench_mcp.clone())
    }

    fn finish(&self, native: &str) {
        let sinks = self.script.sinks.lock().unwrap();
        let sink = &sinks[native];
        let _ = sink.send(SessionEventBody::StatusChanged {
            status: SessionStatus::Completed,
        });
    }

    fn native_of(&self, prompt_part: &str) -> String {
        let sent = self.script.sent.lock().unwrap();
        sent.iter().find(|(_, text)| text.contains(prompt_part)).unwrap().0.clone()
    }

    fn sent_to(&self, native: &str) -> Vec<String> {
        let sent = self.script.sent.lock().unwrap();
        sent.iter().filter(|(id, _)| id == native).map(|(_, text)| text.clone()).collect()
    }

    async fn timeline(&self, session_id: &str) -> Vec<Value> {
        let feed = self.services.snapshot(&format!("session:{session_id}"), &json!({})).unwrap();
        feed["events"].as_array().cloned().unwrap_or_default()
    }

    async fn call(&self, token: &str, tool: &str, arguments: Value) -> (u16, Value) {
        mcp_post(
            self.port,
            Some(token),
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": { "name": tool, "arguments": arguments },
            }),
        )
        .await
    }

    /// 工具结果：成功时解析正文 JSON，失败时给出错误文字。
    async fn tool(&self, token: &str, tool: &str, arguments: Value) -> Result<Value, String> {
        let (status, body) = self.call(token, tool, arguments).await;
        assert_eq!(status, 200, "{body}");
        // 调用方认不出或不在回合里时，工具不会被调用，回的是协议错误。
        if let Some(message) = body["error"]["message"].as_str() {
            return Err(message.to_string());
        }
        let result = &body["result"];
        let text = result["content"][0]["text"].as_str().unwrap_or_default().to_string();
        if result["isError"] == true {
            return Err(text);
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }
}

/// 不带依赖的最小 HTTP/1.1 POST。
async fn mcp_post(port: u16, token: Option<&str>, body: Value) -> (u16, Value) {
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let body = body.to_string();
    let auth = token.map(|token| format!("Authorization: Bearer {token}\r\n")).unwrap_or_default();
    let request = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n\
         Accept: application/json, text/event-stream\r\nMCP-Protocol-Version: 2025-06-18\r\n{auth}\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let raw = String::from_utf8_lossy(&raw).to_string();
    let (head, rest) = raw.split_once("\r\n\r\n").unwrap();
    let status: u16 = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        let mut out = String::new();
        let mut rest = rest;
        while let Some((size, tail)) = rest.split_once("\r\n") {
            let size = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
            if size == 0 {
                break;
            }
            out.push_str(&tail[..size]);
            rest = &tail[size + 2..];
        }
        out
    } else {
        rest.to_string()
    };
    // SSE 回包取最后一个 data 行。
    let json_text = body
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .last()
        .map(str::trim)
        .map(str::to_string)
        .unwrap_or(body);
    (status, serde_json::from_str(&json_text).unwrap_or(Value::Null))
}

#[tokio::test]
async fn subtasks_open_run_and_report_back_once() {
    let h = harness().await;
    let parent = h.create("claude-code", "[hold] 把活拆开", json!({})).await;
    let parent_id = parent["id"].as_str().unwrap().to_string();
    let parent_session = h.wait_state(&parent_id, "working").await;
    let parent_native = h.native_of("把活拆开");
    let token = h.mcp_of(&parent_native).expect("父任务拿到工作台 MCP").token;

    // 没凭证、错凭证都进不来。
    let unauthorized = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    assert_eq!(mcp_post(h.port, None, unauthorized.clone()).await.0, 401);
    assert_eq!(mcp_post(h.port, Some("guess"), unauthorized.clone()).await.0, 401);
    let (status, tools) = mcp_post(h.port, Some(&token), unauthorized).await;
    assert_eq!(status, 200, "{tools}");
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    for tool in ["aiwb_subtask_create", "aiwb_session_create", "aiwb_capabilities"] {
        assert!(names.contains(&tool), "{names:?}");
    }

    let capabilities = h.tool(&token, "aiwb_capabilities", json!({})).await.unwrap();
    assert_eq!(capabilities["you"]["agent"], "claude-code");

    let created = h
        .tool(
            &token,
            "aiwb_subtask_create",
            json!({
                "initiation": "user_asked",
                "clientRequestId": "req-1",
                "subtasks": [
                    { "title": "写代码", "background": BACKGROUND, "prompt": "实现 A", "agent": "codex-cli" },
                    { "title": "写测试", "background": BACKGROUND, "prompt": "测试 A" },
                ],
            }),
        )
        .await
        .unwrap();
    assert_eq!(created["status"], "opened");
    // 重试同一个 id 不再开。
    let again = h
        .tool(
            &token,
            "aiwb_subtask_create",
            json!({ "initiation": "user_asked", "clientRequestId": "req-1", "subtasks": [{ "title": "写代码", "background": BACKGROUND, "prompt": "实现 A" }] }),
        )
        .await
        .unwrap();
    assert_eq!(again, created);

    let children = h.children(&parent_id).await;
    assert_eq!(children.len(), 2);
    // 直接开出的也在父时间线里留一条，界面画成子任务行。
    let opened: Vec<Value> = h
        .timeline(&parent_session)
        .await
        .into_iter()
        .filter(|event| event["kind"] == "subtask-offer")
        .collect();
    assert_eq!(opened.len(), 1, "重试不再记一条");
    assert_eq!(opened[0]["initiation"], "user_asked");
    assert_eq!(opened[0]["resolution"]["kind"], "accepted");
    assert_eq!(opened[0]["resolution"]["task_ids"].as_array().unwrap().len(), 2);
    for child in &children {
        h.wait_state(child["id"].as_str().unwrap(), "done").await;
    }
    let codex_child = children.iter().find(|child| child["title"] == "写代码").unwrap();
    assert_eq!(codex_child["sessions"][0]["agent"], "codex-cli");

    let list = h.tool(&token, "aiwb_subtask_list", json!({})).await.unwrap();
    assert_eq!(list.as_array().unwrap().len(), 2);
    let read = h
        .tool(&token, "aiwb_subtask_read", json!({ "taskId": codex_child["id"] }))
        .await
        .unwrap();
    let kinds: Vec<&str> = read["items"].as_array().unwrap().iter().map(|item| item["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["parent", "answer"], "第一条消息是父任务写的");
    let child_session = codex_child["sessions"][0]["id"].as_str().unwrap();
    let first = h.timeline(child_session).await.into_iter().find(|event| event["kind"] == "user-message").unwrap();
    assert_eq!(first["sender"]["task_ids"][0], parent_id.as_str());

    // 父会话还在回合里，不回报。父回合一结束，两个结果一次送到。
    assert_eq!(h.sent_to(&parent_native).len(), 1);
    h.finish(&parent_native);
    let mut report = None;
    for _ in 0..200 {
        let sent = h.sent_to(&parent_native);
        if sent.len() > 1 {
            report = Some(sent);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let sent = report.expect("父会话收到回报");
    assert_eq!(sent.len(), 2, "只回报一次");
    assert!(sent[1].contains("写代码") && sent[1].contains("写测试") && sent[1].contains("Task:
实现 A"), "{}", sent[1]);
    h.wait_state(&parent_id, "done").await;
    let timeline = h.timeline(&parent_session).await;
    let folded: Vec<&Value> = timeline.iter().filter(|event| event["sender"].is_object()).collect();
    assert_eq!(folded.len(), 1);
    assert_eq!(folded[0]["sender"]["task_ids"].as_array().unwrap().len(), 2);

    // 回合结束后旧凭证不能再动东西。
    let late = h.tool(&token, "aiwb_subtask_list", json!({})).await.unwrap_err();
    assert!(late.starts_with("parent_not_active"), "{late}");
}

#[tokio::test]
async fn cold_subtasks_publish_instructions_before_start_and_never_complete_early() {
    let h = harness().await;
    let parent = h.create("claude-code", "[hold] parent", json!({})).await;
    let parent_id = parent["id"].as_str().unwrap();
    h.wait_state(parent_id, "working").await;
    let token = h.mcp_of(&h.native_of("parent")).unwrap().token;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    *h.script.startup_gate.lock().unwrap() = Some(gate.clone());
    h.tool(&token, "aiwb_subtask_create", json!({ "initiation": "user_asked", "subtasks": [
        { "title": "one", "background": BACKGROUND, "prompt": "[hold] first", "agent": "codex-cli" },
        { "title": "two", "background": BACKGROUND, "prompt": "[hold] second", "agent": "claude-code" }
    ] })).await.unwrap();
    let children = h.children(parent_id).await;
    assert_eq!(children.len(), 2);
    // Allow the native idle event to reach the pump while start_session is blocked.
    tokio::time::sleep(Duration::from_millis(30)).await;
    let mut ids = Vec::new();
    for child in &children {
        let id = child["id"].as_str().unwrap();
        let session = h.wait_state(id, "starting").await;
        let snapshot = h.timeline(&session).await;
        assert_eq!(snapshot.len(), 1, "startup idle must not appear as completed");
        assert_eq!(snapshot[0]["kind"], "user-message");
        assert_eq!(snapshot[0]["sender"]["task_ids"][0], parent_id);
        assert!(snapshot[0]["text"].as_str().unwrap().starts_with("[hold]"));
        // A new subscription / refresh receives the same persisted message.
        assert_eq!(snapshot, h.timeline(&session).await);
        let reopened = Store::open(&h._dirs.0.path().join("db.sqlite")).unwrap();
        assert_eq!(reopened.events_since(&session, 0).unwrap()[0].event.id, snapshot[0]["id"].as_str().unwrap());
        ids.push(snapshot[0]["id"].clone());
    }
    assert_eq!(h.script.sent.lock().unwrap().len(), 1);
    gate.add_permits(2);
    for (index, child) in children.iter().enumerate() {
        let session = h.wait_state(child["id"].as_str().unwrap(), "working").await;
        let events = h.timeline(&session).await;
        let messages: Vec<_> = events.iter().filter(|e| e["kind"] == "user-message").collect();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["id"], ids[index]);
        assert!(!events.iter().any(|e| e["status"] == "completed"));
    }
    assert_eq!(h.script.sent.lock().unwrap().len(), 3, "one delivery per child");
}

#[tokio::test]
async fn cancelling_cold_start_prevents_late_delivery_and_keeps_stopped() {
    let h = harness().await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    *h.script.startup_gate.lock().unwrap() = Some(gate.clone());
    let task = h.create("codex-cli", "must not be sent", json!({})).await;
    let id = task["id"].as_str().unwrap();
    let session = h.wait_state(id, "starting").await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while h.script.started.lock().unwrap().is_empty() { tokio::task::yield_now().await; }
    }).await.unwrap();
    h.services.dispatch("sessions.interrupt", json!({ "sessionId": session })).await.unwrap();
    h.wait_state(id, "idle").await;
    gate.add_permits(1);
    tokio::time::timeout(Duration::from_secs(2), async {
        while h.script.stopped.lock().unwrap().is_empty() { tokio::task::yield_now().await; }
    }).await.unwrap();
    assert!(h.script.sent.lock().unwrap().is_empty());
    assert_eq!(h.task(id).await["sessions"][0]["status"], "stopped");
    assert_eq!(h.timeline(&session).await.iter().filter(|e| e["kind"] == "user-message").count(), 1);
}

#[tokio::test]
async fn failed_cold_start_keeps_instructions_and_records_failure() {
    let h = harness().await;
    h.script.fail_start.store(true, std::sync::atomic::Ordering::SeqCst);
    let task = h.create("codex-cli", "keep this instruction", json!({})).await;
    let session = h.wait_state(task["id"].as_str().unwrap(), "failed").await;
    let events = h.timeline(&session).await;
    assert_eq!(events[0]["text"], "keep this instruction");
    assert_eq!(events.iter().filter(|e| e["kind"] == "error").count(), 1);
    assert!(h.script.sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancelling_a_start_waiting_for_the_opening_lock_never_launches_it() {
    let h = harness().await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    *h.script.startup_gate.lock().unwrap() = Some(gate.clone());
    let first = h.create("codex-cli", "[hold] first", json!({})).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while h.script.started.lock().unwrap().is_empty() { tokio::task::yield_now().await; }
    }).await.unwrap();
    let second = h.create("claude-code", "cancel before launch", json!({})).await;
    let session = second["sessions"][0]["id"].as_str().unwrap();
    h.services.dispatch("sessions.interrupt", json!({ "sessionId": session })).await.unwrap();
    gate.add_permits(2);
    h.wait_state(first["id"].as_str().unwrap(), "working").await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(h.script.started.lock().unwrap().len(), 1);
    assert_eq!(h.script.sent.lock().unwrap().len(), 1);
    assert_eq!(h.task(second["id"].as_str().unwrap()).await["sessions"][0]["status"], "stopped");
}

#[tokio::test]
async fn empty_task_is_not_completed_and_does_not_start_an_agent() {
    let h = harness().await;
    let task = h.create("codex-cli", "", json!({})).await;
    assert_eq!(task["sessions"][0]["status"], "idle");
    assert_eq!(task["attention"]["state"], "new");
    assert!(h.script.started.lock().unwrap().is_empty());
}

/// 子任务也能开子任务：回报一层层往上，下面还有人在做时不叫醒上面。
#[tokio::test]
async fn subtasks_nest_and_report_up_one_level_at_a_time() {
    let h = harness().await;
    let root = h.create("claude-code", "[hold] 顶层", json!({})).await;
    let root_id = root["id"].as_str().unwrap().to_string();
    h.wait_state(&root_id, "working").await;
    let root_native = h.native_of("顶层");
    let root_token = h.mcp_of(&root_native).unwrap().token;

    let opened = |title: &'static str, prompt: &'static str| {
        json!({ "initiation": "user_asked", "subtasks": [{ "title": title, "background": BACKGROUND, "prompt": prompt }] })
    };
    h.tool(&root_token, "aiwb_subtask_create", opened("中间层", "[hold] 中间层的活")).await.unwrap();
    let middle = h.children(&root_id).await.remove(0);
    let middle_id = middle["id"].as_str().unwrap().to_string();
    h.wait_state(&middle_id, "working").await;
    let middle_native = h.native_of("中间层的活");
    let middle_token = h.mcp_of(&middle_native).expect("子任务也拿到工作台 MCP").token;

    h.tool(&middle_token, "aiwb_subtask_create", opened("孙任务", "[hold] 孙任务的活")).await.unwrap();
    let leaf = h.children(&middle_id).await.remove(0);
    let leaf_id = leaf["id"].as_str().unwrap().to_string();
    h.wait_state(&leaf_id, "working").await;
    let leaf_native = h.native_of("孙任务的活");

    // 中间层先结束，孙任务还在做：顶层先不叫醒。
    h.finish(&root_native);
    h.wait_state(&root_id, "done").await;
    h.finish(&middle_native);
    h.wait_state(&middle_id, "done").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(h.sent_to(&root_native).len(), 1, "孙任务还在做，不回报");

    // 孙任务结束：先报给中间层，中间层这一轮结束后才报给顶层。
    h.finish(&leaf_native);
    let mut middle_report = None;
    for _ in 0..200 {
        let sent = h.sent_to(&middle_native);
        if sent.len() > 1 {
            middle_report = Some(sent);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let sent = middle_report.expect("中间层收到孙任务的回报");
    assert!(sent[1].contains("孙任务"), "{}", sent[1]);
    let mut root_report = None;
    for _ in 0..200 {
        let sent = h.sent_to(&root_native);
        if sent.len() > 1 {
            root_report = Some(sent);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let sent = root_report.expect("顶层收到中间层的回报");
    assert!(sent[1].contains("中间层"), "{}", sent[1]);
}

/// 子 Agent 结束单独记一条，排在结束时的位置；卡片留在派出它的位置。
#[tokio::test]
async fn a_subagent_ending_is_recorded_where_it_happened() {
    let h = harness().await;
    let task = h.create("claude-code", "[hold] 派子 Agent", json!({})).await;
    let task_id = task["id"].as_str().unwrap().to_string();
    let session = h.wait_state(&task_id, "working").await;
    let native = h.native_of("派子 Agent");
    let mut card = SubagentCard::new("a", "审查");
    {
        let sinks = h.script.sinks.lock().unwrap();
        let sink = &sinks[&native];
        let _ = sink.send(SessionEventBody::Subagent(card.clone()));
        let _ = sink.send(SessionEventBody::AgentMessage {
            text: "我先看别的".into(),
            stream_id: None,
            phase: None,
            mode: None,
            dedupe_of: None,
        });
        card.finish(SubagentStatus::Completed, Some(1));
        let _ = sink.send(SessionEventBody::Subagent(card));
    }
    let mut kinds = Vec::new();
    for _ in 0..200 {
        kinds = h
            .timeline(&session)
            .await
            .iter()
            .map(|event| event["kind"].as_str().unwrap().to_string())
            .filter(|kind| kind.starts_with("subagent") || kind == "agent-message")
            .collect();
        if kinds.len() >= 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(kinds, ["subagent", "agent-message", "subagent-ended"]);
}

#[tokio::test]
async fn permissions_never_widen_and_waiting_subtasks_refuse_messages() {
    let h = harness().await;
    let parent = h
        .create("codex-cli", "[hold] 拆", json!({ "access": { "mode": "ask" } }))
        .await;
    let parent_id = parent["id"].as_str().unwrap().to_string();
    h.wait_state(&parent_id, "working").await;
    let parent_native = h.native_of("[hold] 拆");
    let token = h.mcp_of(&parent_native).unwrap().token;

    let wider = h
        .tool(
            &token,
            "aiwb_subtask_create",
            json!({ "initiation": "user_asked", "subtasks": [{ "title": "x", "background": BACKGROUND, "prompt": "y", "access": "full" }] }),
        )
        .await
        .unwrap_err();
    assert!(wider.starts_with("permission_escalation"), "{wider}");

    h.tool(
        &token,
        "aiwb_subtask_create",
        json!({ "initiation": "user_asked", "subtasks": [{ "title": "删文件", "background": BACKGROUND, "prompt": "[ask] 删掉旧文件" }] }),
    )
    .await
    .unwrap();
    let child = h.children(&parent_id).await.remove(0);
    assert_eq!(child["sessions"][0]["options"]["access"]["mode"], "ask", "缺省继承父任务");
    let child_id = child["id"].as_str().unwrap().to_string();
    h.wait_state(&child_id, "needs-input").await;

    // 斜杠命令能改子任务的权限，父任务不能发。
    let command = h
        .tool(&token, "aiwb_subtask_send", json!({ "taskId": child_id, "text": "/permissions full" }))
        .await
        .unwrap_err();
    assert!(command.starts_with("invalid"), "{command}");

    let blocked = h
        .tool(&token, "aiwb_subtask_send", json!({ "taskId": child_id, "text": "批准吧" }))
        .await
        .unwrap_err();
    assert!(blocked.starts_with("blocked"), "{blocked}");

    // 别人的任务看不到。
    let other = h.create("codex-cli", "别的任务", json!({})).await;
    let missing = h
        .tool(&token, "aiwb_subtask_read", json!({ "taskId": other["id"] }))
        .await
        .unwrap_err();
    assert!(missing.starts_with("not_found"), "{missing}");

    // 等审批也回报，告诉父任务去找用户。
    h.finish(&parent_native);
    for _ in 0..200 {
        if h.sent_to(&parent_native).len() > 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let sent = h.sent_to(&parent_native);
    assert!(sent.len() > 1 && sent[1].contains("needs-input"), "{sent:?}");

    // 用户归档了的子任务，父任务不能再把它叫起来。先让父会话再进一个回合，凭证才有效。
    h.wait_state(&parent_id, "done").await;
    let parent_session = h.task(&parent_id).await["sessions"][0]["id"].clone();
    h.services
        .dispatch("sessions.send", json!({ "sessionId": parent_session, "text": "[hold] 再看看" }))
        .await
        .unwrap();
    h.wait_state(&parent_id, "working").await;
    h.services
        .dispatch("tasks.archive", json!({ "id": child_id, "archived": true }))
        .await
        .unwrap();
    let archived = h
        .tool(&token, "aiwb_subtask_send", json!({ "taskId": child_id, "text": "继续" }))
        .await
        .unwrap_err();
    assert!(archived.starts_with("not_found"), "{archived}");
}

#[tokio::test]
async fn offer_cards_wait_for_the_user() {
    let h = harness().await;
    let parent = h.create("claude-code", "[hold] 修一下", json!({})).await;
    let parent_id = parent["id"].as_str().unwrap().to_string();
    let session = h.wait_state(&parent_id, "working").await;
    let parent_native = h.native_of("修一下");
    let token = h.mcp_of(&parent_native).unwrap().token;

    let offered = h
        .tool(
            &token,
            "aiwb_subtask_create",
            json!({ "initiation": "offer", "subtasks": [{ "title": "修登录", "background": BACKGROUND, "prompt": "修登录页", "worktree": false }] }),
        )
        .await
        .unwrap();
    assert_eq!(offered["status"], "waiting_for_user");
    assert!(h.children(&parent_id).await.is_empty(), "用户选之前不开");
    for _ in 0..3 {
        h.tool(
            &token,
            "aiwb_subtask_create",
            json!({ "initiation": "own_initiative", "subtasks": [{ "title": format!("顺手 {}", rand_id()), "background": BACKGROUND, "prompt": "p" }] }),
        )
        .await
        .unwrap();
    }
    let too_many = h
        .tool(
            &token,
            "aiwb_subtask_create",
            json!({ "initiation": "own_initiative", "subtasks": [{ "title": "第四个", "background": BACKGROUND, "prompt": "p" }] }),
        )
        .await
        .unwrap_err();
    assert!(too_many.starts_with("too_many_proposals"), "{too_many}");
    h.finish(&parent_native);
    h.wait_state(&parent_id, "done").await;

    let cards: Vec<Value> = h
        .timeline(&session)
        .await
        .into_iter()
        .filter(|event| event["kind"] == "subtask-offer")
        .collect();
    assert_eq!(cards.len(), 4);
    let offer_id = offered["offerId"].as_str().unwrap();
    h.services
        .dispatch("tasks.resolveOffer", json!({ "sessionId": session, "offerId": offer_id, "accept": true }))
        .await
        .unwrap();
    let again = h
        .services
        .dispatch("tasks.resolveOffer", json!({ "sessionId": session, "offerId": offer_id, "accept": false }))
        .await;
    assert!(again.is_err(), "同一张卡片只能选一次");
    assert_eq!(h.children(&parent_id).await.len(), 1);
    let card = h
        .timeline(&session)
        .await
        .into_iter()
        .find(|event| event["offer_id"] == offer_id)
        .unwrap();
    assert_eq!(card["resolution"]["kind"], "accepted");
    // 用户选完马上告诉父会话，不等子任务跑完。
    for _ in 0..200 {
        if h.sent_to(&parent_native).iter().any(|text| text.contains("The user chose to split this off")) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("父会话没收到卡片结果：{:?}", h.sent_to(&parent_native));
}

/// 独立会话：顶层、同一个项目、受调用方权限限制，父任务管不到它，结果也不回来。
#[tokio::test]
async fn detached_sessions_open_at_the_top_level_and_never_report_back() {
    let h = harness().await;
    let origin = h.create("codex-cli", "[hold] 另起一条", json!({ "access": { "mode": "ask" } })).await;
    let origin_id = origin["id"].as_str().unwrap().to_string();
    h.wait_state(&origin_id, "working").await;
    let native = h.native_of("另起一条");
    let token = h.mcp_of(&native).unwrap().token;

    let refused = h
        .tool(
            &token,
            "aiwb_session_create",
            json!({ "initiation": "user_asked", "sessions": [{ "title": "x", "background": BACKGROUND, "prompt": "y", "access": "full" }] }),
        )
        .await
        .unwrap_err();
    assert!(refused.starts_with("permission_escalation"), "{refused}");

    let created = h
        .tool(
            &token,
            "aiwb_session_create",
            json!({ "initiation": "user_asked", "sessions": [{ "title": "独立活", "background": BACKGROUND, "prompt": "独立的活" }] }),
        )
        .await
        .unwrap();
    assert_eq!(created["status"], "opened");
    let task_id = created["sessions"][0]["taskId"].as_str().unwrap().to_string();
    assert!(h.children(&origin_id).await.is_empty(), "不挂在发起的任务下面");
    let detached = h.task(&task_id).await;
    assert!(detached["parentTaskId"].is_null());
    assert_eq!(detached["projectId"], h.project_id.as_str());
    let session = h.wait_state(&task_id, "done").await;
    let first = h.timeline(&session).await.into_iter().find(|event| event["kind"] == "user-message").unwrap();
    assert_eq!(first["sender"]["task_ids"][0], origin_id.as_str(), "时间线里看得出是谁开的");
    assert_eq!(first["text"], "独立的活");
    assert_eq!(first["sender"]["background"], BACKGROUND);
    let delivered = h.sent_to(&h.native_of("独立的活"));
    assert!(delivered[0].contains("Task:\n独立的活"), "{}", delivered[0]);
    assert!(delivered[0].contains(BACKGROUND), "Agent 要收到背景：{}", delivered[0]);

    let foreign = h.tool(&token, "aiwb_subtask_read", json!({ "taskId": task_id })).await.unwrap_err();
    assert!(foreign.starts_with("not_found"), "{foreign}");
    assert!(h.tool(&token, "aiwb_subtask_list", json!({})).await.unwrap().as_array().unwrap().is_empty());

    h.finish(&native);
    h.wait_state(&origin_id, "done").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(h.sent_to(&native).len(), 1, "结果不回来：{:?}", h.sent_to(&native));
}

/// 没给任务的独立会话只是开好等用户；卡片上选了之后 Agent 知道它开了，结果同样不回来。
#[tokio::test]
async fn detached_session_cards_and_empty_sessions() {
    let h = harness().await;
    let origin = h.create("claude-code", "[hold] 新开一个", json!({})).await;
    let origin_id = origin["id"].as_str().unwrap().to_string();
    let session = h.wait_state(&origin_id, "working").await;
    let native = h.native_of("新开一个");
    let token = h.mcp_of(&native).unwrap().token;

    let empty = h
        .tool(&token, "aiwb_session_create", json!({ "initiation": "user_asked", "sessions": [{ "title": "新会话" }] }))
        .await
        .unwrap();
    let empty_id = empty["sessions"][0]["taskId"].as_str().unwrap();
    assert_eq!(h.task(empty_id).await["attention"]["state"], "new");
    assert_eq!(h.script.started.lock().unwrap().len(), 1, "空会话不拉起 Agent");

    let missing = h
        .tool(&token, "aiwb_subtask_create", json!({ "initiation": "user_asked", "subtasks": [{ "title": "没说明" }] }))
        .await
        .unwrap_err();
    assert!(missing.starts_with("invalid: every subtask needs"), "{missing}");

    let offered = h
        .tool(
            &token,
            "aiwb_session_create",
            json!({ "initiation": "offer", "sessions": [{ "title": "问一下", "background": BACKGROUND, "prompt": "问过再开" }] }),
        )
        .await
        .unwrap();
    assert_eq!(offered["status"], "waiting_for_user");
    h.finish(&native);
    h.wait_state(&origin_id, "done").await;
    let offer_id = offered["offerId"].as_str().unwrap();
    h.services
        .dispatch("tasks.resolveOffer", json!({ "sessionId": session, "offerId": offer_id, "accept": true }))
        .await
        .unwrap();
    assert!(h.children(&origin_id).await.is_empty());
    let card = h.timeline(&session).await.into_iter().find(|event| event["offer_id"] == offer_id).unwrap();
    assert_eq!(card["link"], "detached");
    assert_eq!(card["resolution"]["kind"], "accepted");
    for _ in 0..200 {
        if h.sent_to(&native).iter().any(|text| text.contains("nothing will come back to you")) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("发起的会话没收到卡片结果：{:?}", h.sent_to(&native));
}

/// 落库的旧卡片没有 `link`，读出来是子任务。
#[test]
fn stored_cards_without_a_link_are_children() {
    let body: SessionEventBody = serde_json::from_value(json!({
        "kind": "subtask-offer",
        "offer_id": "o",
        "initiation": "offer",
        "subtasks": [],
    }))
    .unwrap();
    let SessionEventBody::SubtaskOffer { link, .. } = body else { panic!() };
    assert_eq!(link, aiwb_core::task::SessionLink::Child);
}

fn rand_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..6].to_string()
}

/// 独立聊天开的独立会话有自己的文件夹，不和聊天共用。
#[tokio::test]
async fn standalone_chats_open_detached_sessions_in_a_new_folder() {
    let h = harness().await;
    let chat = h
        .services
        .dispatch("tasks.create", json!({ "agent": "codex-cli", "prompt": "[hold] 换个地方做", "options": {} }))
        .await
        .unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_string();
    h.wait_state(&chat_id, "working").await;
    let token = h.mcp_of(&h.native_of("换个地方做")).unwrap().token;
    let created = h
        .tool(&token, "aiwb_session_create", json!({ "initiation": "user_asked", "sessions": [{ "title": "别处", "background": BACKGROUND, "prompt": "别处的活" }] }))
        .await
        .unwrap();
    let detached = h.task(created["sessions"][0]["taskId"].as_str().unwrap()).await;
    assert_eq!(detached["workspace"]["kind"], "folder");
    assert_ne!(detached["workspace"]["path"], chat["workspace"]["path"]);
}

/// 独立聊天也拿到工作台 MCP：子任务挂在聊天下面，用同一个文件夹，不能要工作树。
#[tokio::test]
async fn standalone_chats_open_subtasks_in_their_own_folder() {
    let h = harness().await;
    let chat = h
        .services
        .dispatch("tasks.create", json!({ "agent": "codex-cli", "prompt": "[hold] 开个嵌套会话做", "options": {} }))
        .await
        .unwrap();
    let chat_id = chat["id"].as_str().unwrap().to_string();
    assert!(chat["projectId"].is_null());
    let folder = chat["workspace"]["path"].as_str().unwrap().to_string();
    h.wait_state(&chat_id, "working").await;
    let native = h.native_of("开个嵌套会话做");
    let token = h.mcp_of(&native).expect("独立聊天拿到工作台 MCP").token;

    let refused = h
        .tool(
            &token,
            "aiwb_subtask_create",
            json!({ "initiation": "user_asked", "subtasks": [{ "title": "x", "background": BACKGROUND, "prompt": "y", "worktree": true }] }),
        )
        .await
        .unwrap_err();
    assert!(refused.starts_with("invalid: this chat has no git repository"), "{refused}");

    let created = h
        .tool(
            &token,
            "aiwb_subtask_create",
            json!({ "initiation": "user_asked", "subtasks": [{ "title": "审查", "background": BACKGROUND, "prompt": "审查一下", "agent": "claude-code" }] }),
        )
        .await
        .unwrap();
    assert_eq!(created["status"], "opened");
    let children = h.children(&chat_id).await;
    assert_eq!(children.len(), 1);
    let child = &children[0];
    assert!(child["projectId"].is_null());
    assert_eq!(child["workspace"]["kind"], "folder");
    assert_eq!(child["workspace"]["path"], folder.as_str(), "和聊天同一个文件夹");
    h.wait_state(child["id"].as_str().unwrap(), "done").await;
    // 子任务自己不再拿工作台 MCP。
    let child_native = h.native_of("审查一下");
    assert!(h.mcp_of(&child_native).is_some(), "子任务也能开子任务");
}

/// 分叉带着完整对话留在同一个 Agent 上；不分叉就要写背景。发起的会话这时还在回合里。
#[tokio::test]
async fn a_fork_carries_the_conversation_and_fresh_needs_background() {
    let h = harness().await;
    let parent = h.create("claude-code", "[hold] 父任务的活", json!({})).await;
    let parent_id = parent["id"].as_str().unwrap().to_string();
    h.wait_state(&parent_id, "working").await;
    let native = h.native_of("父任务的活");
    let token = h.mcp_of(&native).unwrap().token;
    let create = |item: Value| json!({ "initiation": "user_asked", "subtasks": [item] });

    for (item, expected) in [
        (json!({ "title": "x", "prompt": "y" }), "background"),
        (json!({ "title": "x", "prompt": "y", "background": "太短" }), "background"),
        (json!({ "title": "x", "prompt": "y", "context": "fork", "agent": "codex-cli" }), "own agent"),
        (json!({ "title": "x", "prompt": "y", "context": "fork", "worktree": true }), "cannot be set on a fork"),
    ] {
        let refused = h.tool(&token, "aiwb_subtask_create", create(item)).await.unwrap_err();
        assert!(refused.contains(expected), "{refused}");
    }
    assert!(h.children(&parent_id).await.is_empty());

    h.tool(&token, "aiwb_subtask_create", create(json!({ "title": "分叉", "prompt": "接着做", "context": "fork" }))).await.unwrap();
    let child = h.children(&parent_id).await.remove(0);
    let child_id = child["id"].as_str().unwrap().to_string();
    let session = h.wait_state(&child_id, "done").await;
    let fork_native = format!("fork-of-{native}");
    assert_eq!(h.task(&child_id).await["sessions"][0]["nativeId"], fork_native.as_str());
    let sent = h.sent_to(&fork_native);
    assert!(sent[0].starts_with("Task (from the session that started this one):
接着做"), "{}", sent[0]);
    assert!(sent[0].contains("Shared notes folder"), "{}", sent[0]);
    assert!(h.mcp_of(&fork_native).unwrap().child, "子任务收到专用说明");
    assert!(!h.mcp_of(&native).unwrap().child);

    let users: Vec<Value> = h.timeline(&session).await.into_iter().filter(|event| event["kind"] == "user-message").collect();
    assert_eq!(users[0]["text"], "[hold] 父任务的活", "时间线抄了父对话");
    let task = users.iter().find(|event| event["sender"]["fork"] == true).expect("分叉后的任务单独标出来");
    assert_eq!(task["text"], "接着做");
    assert_eq!(task["sender"]["task_ids"][0], parent_id.as_str());
}
