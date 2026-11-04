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
    SessionEventBody, SessionStatus,
};
use aiwb_core::DaemonInfo;
use aiwb_daemon::{router, AdapterFactory, Services};
use aiwb_store::Store;
use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
struct Script {
    /// 每次拉起进程时的原生 id 和上下文。
    started: Mutex<Vec<(String, SessionContext)>>,
    sinks: Mutex<HashMap<String, EventSink>>,
    /// 每个原生会话收到的消息原文。
    sent: Mutex<Vec<(String, String)>>,
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
    assert!(names.contains(&"aiwb_subtask_create") && names.contains(&"aiwb_capabilities"), "{names:?}");

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
                    { "title": "写代码", "prompt": "实现 A", "agent": "codex-cli" },
                    { "title": "写测试", "prompt": "测试 A" },
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
            json!({ "initiation": "user_asked", "clientRequestId": "req-1", "subtasks": [{ "title": "写代码", "prompt": "实现 A" }] }),
        )
        .await
        .unwrap();
    assert_eq!(again, created);

    let children = h.children(&parent_id).await;
    assert_eq!(children.len(), 2);
    for child in &children {
        h.wait_state(child["id"].as_str().unwrap(), "done").await;
    }
    let codex_child = children.iter().find(|child| child["title"] == "写代码").unwrap();
    assert_eq!(codex_child["sessions"][0]["agent"], "codex-cli");

    // 子任务没有工作台 MCP：不能再开子任务。
    let started = h.script.started.lock().unwrap();
    let child_contexts: Vec<_> = started
        .iter()
        .filter(|(native, _)| *native != parent_native)
        .collect();
    assert_eq!(child_contexts.len(), 2);
    assert!(child_contexts.iter().all(|(_, ctx)| ctx.workbench_mcp.is_none()));
    drop(started);

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
    assert!(sent[1].contains("写代码") && sent[1].contains("写测试") && sent[1].contains("收到：实现 A"), "{}", sent[1]);
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
            json!({ "initiation": "user_asked", "subtasks": [{ "title": "x", "prompt": "y", "access": "full" }] }),
        )
        .await
        .unwrap_err();
    assert!(wider.starts_with("permission_escalation"), "{wider}");

    h.tool(
        &token,
        "aiwb_subtask_create",
        json!({ "initiation": "user_asked", "subtasks": [{ "title": "删文件", "prompt": "[ask] 删掉旧文件" }] }),
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
            json!({ "initiation": "offer", "subtasks": [{ "title": "修登录", "prompt": "修登录页", "worktree": false }] }),
        )
        .await
        .unwrap();
    assert_eq!(offered["status"], "waiting_for_user");
    assert!(h.children(&parent_id).await.is_empty(), "用户选之前不开");
    for _ in 0..3 {
        h.tool(
            &token,
            "aiwb_subtask_create",
            json!({ "initiation": "own_initiative", "subtasks": [{ "title": format!("顺手 {}", rand_id()), "prompt": "p" }] }),
        )
        .await
        .unwrap();
    }
    let too_many = h
        .tool(
            &token,
            "aiwb_subtask_create",
            json!({ "initiation": "own_initiative", "subtasks": [{ "title": "第四个", "prompt": "p" }] }),
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

fn rand_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..6].to_string()
}
