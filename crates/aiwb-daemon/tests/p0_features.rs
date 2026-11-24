//! P0 八大能力端到端后端集成测试：
//! 1. `pv-01` 多账号多实例 CRUD、敏感环境变量脱敏与同种 Agent 跨实例切换交接
//! 2. `pv-02` 轻量文本生成通道（本地 HTTP Mock 验证标题、分支名、Git Commit 说明与密钥掩码保留）
//! 3. `or-01` 逐轮 Git 隐藏引用快照、双模回退（还原文件保留 `.gitignore` 产物）与并发/手动改动安全门控
//! 4. `ws-01` SQLite FTS5 Trigram 跨项目会话正文检索与 1~2 字短词回退
//! 5. `tm-02` `files.resolve` 终端报错路径解析（含 `a/` `b/` 前缀剥离）
//! 6. `dk-03` `settings.keybindings` 读写校验与恢复默认

use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

use aiwb_agents::{
    AgentAdapter, AgentError, AgentSession, AnnotationSink, DiffScopeProvider, DirectoryEntry,
    EventSink, SessionContext, TurnDelivery,
};
use aiwb_core::checkpoint::{RewindPreview, RewindResult, TurnCheckpoint};
use aiwb_core::models::{
    AgentCapabilities, AgentCatalog, AgentInstance, AgentKind, GeneratedCommitMessage,
    PageAnnotation, PromptAnswer, SessionEventBody, SessionStatus, TextGenSettings,
    SECRET_REDACTED,
};
use aiwb_core::search::TaskSearchHit;
use aiwb_core::DaemonInfo;
use aiwb_daemon::{AdapterFactory, Services};
use aiwb_store::Store;
use async_trait::async_trait;
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};

#[derive(Default)]
struct Script {
    sent: Mutex<Vec<(AgentKind, String)>>,
    rewound: Mutex<Vec<(String, Option<String>, usize)>>,
    worktree_action: Mutex<Option<Box<dyn FnMut(&Path) + Send>>>,
    /// 模拟原生队列自动发出后续回合：先改文件再上报 `UserMessage`（复现 Codex 原生队列竞态）。
    auto_queued_turn: Mutex<Option<(String, String)>>,
    /// 模拟正在执行中的长回合（只报 Running，不发 Completed）。
    stay_running: Mutex<bool>,
}

struct FakeAdapter(Arc<Script>, AgentKind);

struct FakeSession {
    sink: EventSink,
    native: String,
    kind: AgentKind,
    cwd: String,
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
            AgentKind::CursorAgent => AgentCapabilities::cursor(),
            AgentKind::Antigravity => AgentCapabilities::antigravity(),
            _ => AgentCapabilities::codex(),
        }
    }

    async fn detect(&self) -> Result<(), AgentError> {
        Ok(())
    }

    fn session_linked(&self) -> bool {
        true
    }

    async fn fork_thread(
        &self,
        native_id: &str,
        _cwd: Option<&str>,
    ) -> Result<DirectoryEntry, AgentError> {
        Ok(DirectoryEntry {
            native_id: format!("fork-{native_id}"),
            cwd: String::new(),
            cwd_key: String::new(),
            title: String::new(),
            created_at: 1,
            updated_at: 1,
            status: SessionStatus::Completed,
            ephemeral: false,
            archived: false,
        })
    }

    async fn rewind_thread(
        &self,
        native_id: &str,
        _cwd: &str,
        target_turn_id: Option<&str>,
        kept_turns: usize,
        _delete_old: bool,
    ) -> Result<Option<String>, AgentError> {
        self.0.rewound.lock().unwrap().push((
            native_id.to_string(),
            target_turn_id.map(str::to_string),
            kept_turns,
        ));
        match self.1 {
            AgentKind::CodexCli => Ok(Some(format!("{native_id}-rewound"))),
            AgentKind::ClaudeCode => Ok(Some(native_id.to_string())),
            _ => Ok(None),
        }
    }

    async fn start_session(
        &self,
        ctx: SessionContext,
        events: EventSink,
    ) -> Result<Arc<dyn AgentSession>, AgentError> {
        let native = ctx
            .resume_native_id
            .clone()
            .unwrap_or_else(|| format!("native-{}", self.1.as_str()));
        let _ = events.send(SessionEventBody::StatusChanged {
            status: SessionStatus::Completed,
        });
        Ok(Arc::new(FakeSession {
            sink: events,
            native,
            kind: self.1,
            cwd: ctx.project_path,
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
        let turn_num = {
            let mut sent = self.script.sent.lock().unwrap();
            sent.push((self.kind, text.clone()));
            sent.len()
        };
        let _ = self.sink.send(SessionEventBody::TurnAnchor {
            turn_id: format!("turn-{turn_num}"),
            mode: None,
        });
        let _ = self.sink.send(SessionEventBody::StatusChanged {
            status: SessionStatus::Running,
        });
        if let Some(action) = self.script.worktree_action.lock().unwrap().as_mut() {
            action(Path::new(&self.cwd));
        }
        if *self.script.stay_running.lock().unwrap() {
            let _ = self.sink.send(SessionEventBody::AgentMessage {
                text: format!("正在执行第 {turn_num} 轮：{text}"),
                stream_id: Some(format!("s-{turn_num}")),
                phase: None,
                mode: None,
                dedupe_of: None,
            });
            return Ok(());
        }
        let _ = self.sink.send(SessionEventBody::AgentMessage {
            text: format!("已完成第 {turn_num} 轮：{text}"),
            stream_id: Some(format!("s-{turn_num}")),
            phase: None,
            mode: None,
            dedupe_of: None,
        });
        let _ = self.sink.send(SessionEventBody::StatusChanged {
            status: SessionStatus::Completed,
        });
        if let Some((queued_text, queued_file_content)) =
            self.script.auto_queued_turn.lock().unwrap().take()
        {
            // 模拟原生队列在适配器发回 UserMessage 之前已经开始执行并写入磁盘文件。
            fs::write(Path::new(&self.cwd).join("app.txt"), queued_file_content).unwrap();
            let _ = self.sink.send(SessionEventBody::TurnAnchor {
                turn_id: format!("turn-queued-{turn_num}"),
                mode: None,
            });
            let _ = self.sink.send(SessionEventBody::StatusChanged {
                status: SessionStatus::Running,
            });
            let _ = self.sink.send(SessionEventBody::UserMessage {
                text: queued_text.clone(),
                images: Vec::new(),
                annotations: 0,
                sender: None,
            });
            let _ = self.sink.send(SessionEventBody::AgentMessage {
                text: format!("队列回合完成：{queued_text}"),
                stream_id: Some(format!("s-queued-{turn_num}")),
                phase: None,
                mode: None,
                dedupe_of: None,
            });
            let _ = self.sink.send(SessionEventBody::StatusChanged {
                status: SessionStatus::Completed,
            });
        }
        Ok(())
    }

    async fn answer_prompt(&self, _id: &str, _answer: PromptAnswer) -> Result<(), AgentError> {
        Ok(())
    }

    async fn stop(&self) -> Result<(), AgentError> {
        Ok(())
    }

    async fn catalog(&self) -> Result<AgentCatalog, AgentError> {
        let mut cat = AgentCatalog::empty();
        cat.capabilities = match self.kind {
            AgentKind::ClaudeCode => AgentCapabilities::claude(),
            _ => AgentCapabilities::codex(),
        };
        Ok(cat)
    }

    fn native_id(&self) -> Option<String> {
        Some(self.native.clone())
    }
}

fn setup() -> (tempfile::TempDir, Arc<Store>, Arc<Script>, Arc<Services>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_in_memory().unwrap());
    let script = Arc::new(Script::default());
    let s = script.clone();
    let factory: AdapterFactory = Arc::new(move |kind| Arc::new(FakeAdapter(s.clone(), kind)));
    let services = Arc::new(Services::with_adapters(
        store.clone(),
        DaemonInfo {
            version: "test".into(),
            build: String::new(),
            pid: 1,
            port: 0,
            token: "tok".into(),
        },
        dir.path().join("data"),
        factory,
    ));
    (dir, store, script, services)
}

fn init_git_repo(path: &Path) {
    fs::create_dir_all(path).unwrap();
    let run = |args: &[&str]| {
        let out = Command::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    };
    run(&["init", "-b", "main"]);
    run(&["config", "user.name", "Test User"]);
    run(&["config", "user.email", "test@example.com"]);
    run(&["config", "core.autocrlf", "false"]);
    fs::write(path.join(".gitignore"), "node_modules/\n").unwrap();
    fs::write(path.join("app.txt"), "v0\n").unwrap();
    run(&["add", "."]);
    run(&["commit", "-m", "chore: initial commit"]);
}

#[tokio::test]
async fn instances_crud_secret_redaction_and_same_kind_switch() {
    let (dir, store, script, services) = setup();
    let repo = dir.path().join("proj");
    init_git_repo(&repo);

    let proj = services
        .dispatch("projects.add", json!({ "path": repo }))
        .await
        .unwrap();
    let project_id = proj["id"].as_str().unwrap().to_string();

    // 1. 新建第二个 Codex 实例（带敏感 API Key 和 ShadowHome 隔离）
    let created: AgentInstance = serde_json::from_value(
        services
            .dispatch(
                "instances.upsert",
                json!({
                    "id": "codex-work",
                    "kind": "codex-cli",
                    "displayName": "Codex 工作号",
                    "accentColor": "#3b82f6",
                    "enabled": true,
                    "isolationMode": "shadowHome",
                    "environment": [
                        { "name": "OPENAI_BASE_URL", "value": "https://gw.corp.internal/v1", "sensitive": false },
                        { "name": "OPENAI_API_KEY", "value": "sk-super-secret-999", "sensitive": true }
                    ]
                }),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(created.id, "codex-work");
    assert_eq!(created.environment[1].value, "");
    assert!(created.environment[1].value_redacted);

    // 库里保存的是真实明文
    let raw_in_db = store.agent_instance("codex-work").unwrap().unwrap();
    assert_eq!(raw_in_db.environment[1].value, "sk-super-secret-999");

    // 2. 二次编辑只改名字，保持掩码不丢失库里的真实密钥
    let updated: AgentInstance = serde_json::from_value(
        services
            .dispatch(
                "instances.upsert",
                json!({
                    "id": "codex-work",
                    "kind": "codex-cli",
                    "displayName": "Codex 企业网关",
                    "accentColor": "#10b981",
                    "enabled": true,
                    "isolationMode": "shadowHome",
                    "environment": [
                        { "name": "OPENAI_BASE_URL", "value": "https://gw.corp.internal/v1", "sensitive": false },
                        { "name": "OPENAI_API_KEY", "value": SECRET_REDACTED, "sensitive": true, "valueRedacted": true }
                    ]
                }),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(updated.display_name, "Codex 企业网关");
    let raw_after = store.agent_instance("codex-work").unwrap().unwrap();
    assert_eq!(raw_after.environment[1].value, "sk-super-secret-999");

    // 3. agents.profiles 同时返回默认实例与自定义实例
    let profiles = services
        .dispatch("agents.profiles", json!({}))
        .await
        .unwrap();
    let arr = profiles.as_array().unwrap();
    assert!(arr.iter().any(|p| p["instance_id"].as_str() == Some("codex-work")
        && p["display_name"].as_str() == Some("Codex 企业网关")
        && p["accent_color"].as_str() == Some("#10b981")));

    // 4. 在默认实例新建会话并发出第一轮，再切换到同一个 AgentKind 下的 `codex-work` 实例
    let entry = services
        .dispatch(
            "tasks.create",
            json!({
                "projectId": project_id,
                "agent": "codex-cli",
                "prompt": "",
                "options": {}
            }),
        )
        .await
        .unwrap();
    let task_id = entry["id"].as_str().unwrap().to_string();
    let s1 = entry["sessions"][0]["id"].as_str().unwrap().to_string();

    services
        .dispatch("sessions.send", json!({ "sessionId": s1, "text": "记住暗号 ALPHA-42" }))
        .await
        .unwrap();

    let switched = services
        .dispatch(
            "tasks.switchAgent",
            json!({
                "taskId": task_id,
                "agent": "codex-cli",
                "instanceId": "codex-work",
                "options": {}
            }),
        )
        .await
        .unwrap();
    let sessions = switched["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[1]["instanceId"].as_str(), Some("codex-work"));
    let s2 = sessions[1]["id"].as_str().unwrap().to_string();

    services
        .dispatch("sessions.send", json!({ "sessionId": s2, "text": "刚才的暗号是什么？" }))
        .await
        .unwrap();

    // 第二实例收到的首条消息自动附带了默认实例的前文交接
    let sent = script.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 2);
    assert!(
        sent[1].1.contains("ALPHA-42") && sent[1].1.contains("刚才的暗号是什么？"),
        "expected handoff context in second instance message, got: {}",
        sent[1].1
    );
}

#[tokio::test]
async fn text_gen_http_mock_title_branch_and_commit() {
    let (dir, store, _script, services) = setup();
    let repo = dir.path().join("repo-tg");
    init_git_repo(&repo);
    fs::write(repo.join("app.txt"), "v0\nfeature line\n").unwrap();

    // 启动本地 Mock OpenAI 兼容端点
    let app = Router::new().route(
        "/v1/chat/completions",
        post(|Json(body): Json<Value>| async move {
            let prompt = body["messages"][0]["content"].as_str().unwrap_or_default();
            let reply = if prompt.contains("<diff") {
                "{\"subject\":\"feat(app): add feature line\",\"body\":\"- append feature line to app.txt\"}"
            } else if prompt.contains("branch name") {
                "feat/terminal-context-chip"
            } else {
                "多账号隔离架构设计"
            };
            Json(json!({
                "choices": [{ "message": { "content": reply } }]
            }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    // 保存 HTTP TextGen 配置并验证密钥掩码保留
    let saved: TextGenSettings = serde_json::from_value(
        services
            .dispatch(
                "settings.setTextGen",
                json!({
                    "mode": "http",
                    "autoTitle": true,
                    "http": {
                        "protocol": "openAi",
                        "baseUrl": format!("http://{addr}"),
                        "apiKey": "sk-tg-secret",
                        "model": "gpt-4o-mini"
                    }
                }),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(saved.http.as_ref().unwrap().api_key_redacted);
    assert!(saved.http.as_ref().unwrap().api_key.is_empty());

    // 再次保存空掩码不会冲掉已存的 apiKey
    services
        .dispatch(
            "settings.setTextGen",
            json!({
                "mode": "http",
                "autoTitle": true,
                "http": {
                    "protocol": "openAi",
                    "baseUrl": format!("http://{addr}"),
                    "apiKey": "",
                    "apiKeyRedacted": true,
                    "model": "gpt-4o-mini"
                }
            }),
        )
        .await
        .unwrap();
    let raw_meta = store.meta("text_gen.settings").unwrap().unwrap();
    assert!(raw_meta.contains("sk-tg-secret"));

    let proj = services
        .dispatch("projects.add", json!({ "path": repo }))
        .await
        .unwrap();
    let project_id = proj["id"].as_str().unwrap().to_string();

    let entry = services
        .dispatch(
            "tasks.create",
            json!({
                "projectId": project_id,
                "agent": "codex-cli",
                "prompt": "",
                "options": {}
            }),
        )
        .await
        .unwrap();
    let task_id = entry["id"].as_str().unwrap().to_string();
    let sid = entry["sessions"][0]["id"].as_str().unwrap().to_string();
    services
        .dispatch("sessions.send", json!({ "sessionId": sid, "text": "请设计多账号与多实例隔离方案" }))
        .await
        .unwrap();

    // 1. 显式重新生成标题
    let regen = services
        .dispatch("tasks.regenerateTitle", json!({ "taskId": task_id }))
        .await
        .unwrap();
    assert_eq!(regen["title"].as_str(), Some("多账号隔离架构设计"));
    assert!(!store.is_task_title_customized(&task_id).unwrap());

    // 手动重命名会置上 customized 标记
    services
        .dispatch("tasks.rename", json!({ "id": task_id, "title": "我手动改的标题" }))
        .await
        .unwrap();
    assert!(store.is_task_title_customized(&task_id).unwrap());

    // 2. 生成分支名
    let branch = services
        .dispatch(
            "textGen.branchName",
            json!({ "taskId": task_id, "prompt": "Add terminal selection context chip" }),
        )
        .await
        .unwrap();
    assert_eq!(branch["branch"].as_str(), Some("feat/terminal-context-chip"));

    // 3. 生成 Git Commit 说明
    let commit: GeneratedCommitMessage = serde_json::from_value(
        services
            .dispatch(
                "textGen.commitMessage",
                json!({ "sessionId": sid, "diffScope": "uncommitted" }),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(commit.subject, "feat(app): add feature line");
    assert!(commit.message.contains("- append feature line to app.txt"));
}

#[tokio::test]
async fn checkpoints_capture_dual_mode_rewind_and_safety_guards() {
    let (dir, store, script, services) = setup();
    let repo = dir.path().join("repo-cp");
    init_git_repo(&repo);

    // 写入 `.gitignore` 忽略的构建缓存，验证文件回退不会误删它
    fs::create_dir_all(repo.join("node_modules")).unwrap();
    fs::write(repo.join("node_modules/cache.bin"), "keep-me").unwrap();

    let proj = services
        .dispatch("projects.add", json!({ "path": repo }))
        .await
        .unwrap();
    let project_id = proj["id"].as_str().unwrap().to_string();

    let entry = services
        .dispatch(
            "tasks.create",
            json!({
                "projectId": project_id,
                "agent": "codex-cli",
                "prompt": "",
                "options": {}
            }),
        )
        .await
        .unwrap();
    let task_id = entry["id"].as_str().unwrap().to_string();
    let sid = entry["sessions"][0]["id"].as_str().unwrap().to_string();

    // 第 1 轮：把 app.txt 改为 v1，并新增 extra.rs
    *script.worktree_action.lock().unwrap() = Some(Box::new(|cwd: &Path| {
        fs::write(cwd.join("app.txt"), "v1\n").unwrap();
        fs::write(cwd.join("extra.rs"), "pub fn v1() {}\n").unwrap();
    }));
    services
        .dispatch("sessions.send", json!({ "sessionId": sid, "text": "第一轮修改" }))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;

    // 第 2 轮：把 app.txt 改坏为 broken，并新增 bad.rs
    *script.worktree_action.lock().unwrap() = Some(Box::new(|cwd: &Path| {
        fs::write(cwd.join("app.txt"), "broken-v2\n").unwrap();
        fs::write(cwd.join("bad.rs"), "compile_error!(\"oops\");\n").unwrap();
    }));
    services
        .dispatch(
            "sessions.send",
            json!({
                "sessionId": sid,
                "text": "第二轮改坏了代码",
                "images": ["C:/tmp/mock-shot.png"]
            }),
        )
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;

    let cps: Vec<TurnCheckpoint> = store.session_checkpoints(&sid).unwrap();
    assert_eq!(cps.len(), 2);
    assert!(cps[0].pre_ref.is_some());
    assert!(cps[1].pre_ref.is_some());
    let turn2_event_id = cps[1].user_event_id.clone();

    // 模拟用户在第 2 轮结束后又手动改了文件 -> 预检应提示 hasManualEditsWarning
    fs::write(repo.join("app.txt"), "manual-tweak\n").unwrap();
    let preview_manual: RewindPreview = serde_json::from_value(
        services
            .dispatch(
                "sessions.rewindPreview",
                json!({ "sessionId": sid, "userEventId": turn2_event_id }),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(preview_manual.can_restore_files);
    assert!(preview_manual.has_manual_edits_warning);
    assert_eq!(preview_manual.turns_to_remove, 1);

    // 在同一检出目录新建另一个任务并发一轮 -> 预检应禁止当前旧任务覆盖磁盘文件，但仍允许仅回退对话
    *script.worktree_action.lock().unwrap() = None;
    let other_task = services
        .dispatch(
            "tasks.create",
            json!({
                "projectId": project_id,
                "agent": "codex-cli",
                "prompt": "",
                "options": {}
            }),
        )
        .await
        .unwrap();
    let other_task_id = other_task["id"].as_str().unwrap().to_string();
    let other_sid = other_task["sessions"][0]["id"].as_str().unwrap().to_string();
    services
        .dispatch("sessions.send", json!({ "sessionId": other_sid, "text": "另一个会话的新改动" }))
        .await
        .unwrap();

    let preview_blocked: RewindPreview = serde_json::from_value(
        services
            .dispatch(
                "sessions.rewindPreview",
                json!({ "sessionId": sid, "userEventId": turn2_event_id }),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(!preview_blocked.can_restore_files);
    assert!(preview_blocked.file_restore_disabled_reason.is_some());

    // 删除并发任务后，执行「对话 + 文件双模回退」回到第 2 轮开始前
    services
        .dispatch("tasks.remove", json!({ "id": other_task_id }))
        .await
        .unwrap();

    let res: RewindResult = serde_json::from_value(
        services
            .dispatch(
                "sessions.rewind",
                json!({
                    "sessionId": sid,
                    "userEventId": turn2_event_id,
                    "restoreFiles": true
                }),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(res.files_restored);
    assert_eq!(res.restored_text, "第二轮改坏了代码");
    assert_eq!(res.restored_images, vec!["C:/tmp/mock-shot.png"]);
    assert_eq!(fs::read_to_string(repo.join("app.txt")).unwrap(), "v1\n");
    assert!(repo.join("extra.rs").exists(), "turn 1 file should remain");
    assert!(!repo.join("bad.rs").exists(), "turn 2 untracked file should be cleaned");
    assert_eq!(
        fs::read_to_string(repo.join("node_modules/cache.bin")).unwrap(),
        "keep-me",
        ".gitignored artifacts must never be wiped"
    );
    let _ = task_id;
}

#[tokio::test]
async fn full_text_search_files_resolve_and_keybindings_rpc() {
    let (dir, _store, _script, services) = setup();
    let repo = dir.path().join("repo-search");
    init_git_repo(&repo);
    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(repo.join("src/widget.ts"), "export const x = 1;\n").unwrap();

    let proj = services
        .dispatch("projects.add", json!({ "path": repo }))
        .await
        .unwrap();
    let project_id = proj["id"].as_str().unwrap().to_string();

    let entry = services
        .dispatch(
            "tasks.create",
            json!({
                "projectId": project_id,
                "agent": "codex-cli",
                "prompt": "",
                "options": {}
            }),
        )
        .await
        .unwrap();
    let task_id = entry["id"].as_str().unwrap().to_string();
    let sid = entry["sessions"][0]["id"].as_str().unwrap().to_string();

    services
        .dispatch(
            "sessions.send",
            json!({
                "sessionId": sid,
                "text": "报错栈：panicked at crates/aiwb-store/src/search.rs:42 互斥锁重入异常"
            }),
        )
        .await
        .unwrap();

    // 1. FTS5 Trigram (>=3 chars) 搜英文路径片段与中文短语
    let hits_en: Vec<TaskSearchHit> = serde_json::from_value(
        services
            .dispatch("tasks.search", json!({ "query": "aiwb-store/src/search.rs" }))
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(!hits_en.is_empty());
    assert_eq!(hits_en[0].task_id, task_id);
    assert!(hits_en[0].event_id.is_some());
    assert!(hits_en[0].snippet.contains("aiwb-store/src/search.rs"));

    // 2. 2 字中文短词走 LIKE 回退同样命中
    let hits_short: Vec<TaskSearchHit> = serde_json::from_value(
        services
            .dispatch("tasks.search", json!({ "query": "互斥" }))
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(!hits_short.is_empty());

    // 3. 归档默认过滤，`includeArchived: true` 才返回
    services
        .dispatch("tasks.archive", json!({ "id": task_id, "archived": true }))
        .await
        .unwrap();
    let hits_unarchived: Vec<TaskSearchHit> = serde_json::from_value(
        services
            .dispatch("tasks.search", json!({ "query": "互斥锁重入" }))
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(hits_unarchived.is_empty());

    let hits_with_archived: Vec<TaskSearchHit> = serde_json::from_value(
        services
            .dispatch(
                "tasks.search",
                json!({ "query": "互斥锁重入", "includeArchived": true }),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(hits_with_archived.len(), 1);

    // 4. `files.resolve` 支持 `./` 与 `a/` git diff 前缀剥离，并拒绝不存在路径
    let resolved_rel = services
        .dispatch(
            "files.resolve",
            json!({ "projectId": project_id, "path": "a/src/widget.ts" }),
        )
        .await
        .unwrap();
    assert_eq!(resolved_rel["exists"].as_bool(), Some(true));
    assert!(
        resolved_rel["path"]
            .as_str()
            .is_some_and(|p| p.replace('\\', "/").ends_with("src/widget.ts"))
    );

    let resolved_missing = services
        .dispatch(
            "files.resolve",
            json!({ "projectId": project_id, "path": "src/does-not-exist.ts" }),
        )
        .await
        .unwrap();
    assert_eq!(resolved_missing["exists"].as_bool(), Some(false));
    assert!(resolved_missing["path"].is_null());

    // 5. `settings.keybindings` / `setKeybindings` / `resetKeybindings`
    let initial_kb = services
        .dispatch("settings.keybindings", json!({}))
        .await
        .unwrap();
    assert!(initial_kb["rules"].as_array().unwrap().is_empty());
    assert!(initial_kb["path"].as_str().unwrap().ends_with("keybindings.json"));

    let updated_kb = services
        .dispatch(
            "settings.setKeybindings",
            json!({
                "rules": [
                    { "key": "Mod+Shift+P", "command": "commandMenu.toggle", "when": "!modalOpen" }
                ]
            }),
        )
        .await
        .unwrap();
    assert_eq!(updated_kb["rules"].as_array().unwrap().len(), 1);

    let reset_kb = services
        .dispatch("settings.setKeybindings", json!({ "rules": [] }))
        .await
        .unwrap();
    assert!(reset_kb["rules"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn rewind_counts_sender_turns_and_instance_update_discards_idle_side_sessions() {
    let (dir, store, script, services) = setup();
    let repo = dir.path().join("repo-r2");
    init_git_repo(&repo);

    let proj = services
        .dispatch("projects.add", json!({ "path": repo }))
        .await
        .unwrap();
    let project_id = proj["id"].as_str().unwrap().to_string();

    // 1. 验证子任务/工作台代发首轮（`sender: Some(_)`）存在时，回退第 2 轮会统计 `kept_turns == 1` 并保留第 1 轮原生上下文
    let entry = services
        .dispatch(
            "tasks.create",
            json!({
                "projectId": project_id,
                "agent": "codex-cli",
                "prompt": "",
                "options": {}
            }),
        )
        .await
        .unwrap();
    let task_id = entry["id"].as_str().unwrap().to_string();
    let sid = entry["sessions"][0]["id"].as_str().unwrap().to_string();

    store
        .set_session_native_id(&sid, "native-child-session")
        .unwrap();
    let mut seq = 1u64;
    let mut rev = 1u64;
    for body in [
        SessionEventBody::UserMessage {
            text: "请先完成子任务初始调研".into(),
            images: Vec::new(),
            annotations: 0,
            sender: Some(aiwb_core::models::MessageSender {
                task_ids: vec!["parent-1".into()],
                fork: true,
                ..Default::default()
            }),
        },
        SessionEventBody::TurnAnchor {
            turn_id: "turn-child-1".into(),
            mode: None,
        },
        SessionEventBody::AgentMessage {
            text: "已完成子任务初始调研".into(),
            stream_id: Some("s-child-1".into()),
            phase: None,
            mode: None,
            dedupe_of: None,
        },
        SessionEventBody::StatusChanged {
            status: SessionStatus::Completed,
        },
    ] {
        let ev = aiwb_core::models::SessionEvent {
            id: aiwb_core::models::new_id(),
            session_id: sid.clone(),
            seq,
            ts: 1_000 + seq as i64,
            body,
        };
        store
            .put_event(
                &task_id,
                &aiwb_core::task::StoredEvent { event: ev, rev },
                true,
                None,
            )
            .unwrap();
        seq += 1;
        rev += 1;
    }

    services
        .dispatch(
            "sessions.send",
            json!({ "sessionId": sid, "text": "用户追加第 2 轮指令" }),
        )
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let cps = store.session_checkpoints(&sid).unwrap();
    assert_eq!(cps.len(), 1);
    let turn2_event_id = cps[0].user_event_id.clone();

    let res: RewindResult = serde_json::from_value(
        services
            .dispatch(
                "sessions.rewind",
                json!({
                    "sessionId": sid,
                    "userEventId": turn2_event_id,
                    "restoreFiles": false
                }),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(res.restored_text, "用户追加第 2 轮指令");

    let rewound = script.rewound.lock().unwrap().clone();
    assert_eq!(rewound.len(), 1);
    assert_eq!(rewound[0].0, "native-child-session");
    assert_eq!(rewound[0].2, 1, "standalone sender turn 1 must be counted in kept_turns");
    let after_session = store.session(&sid).unwrap().unwrap();
    assert_eq!(
        after_session.native_id.as_deref(),
        Some("native-child-session-rewound")
    );
    assert_eq!(after_session.status, SessionStatus::Completed);

    // 2. 验证更新实例配置时，该实例下空闲的临时侧边聊天（side = 1）被彻底丢弃而非残留空壳行
    let side = services
        .dispatch(
            "tasks.openSide",
            json!({
                "taskId": task_id,
                "agent": "codex-cli",
                "options": {}
            }),
        )
        .await
        .unwrap();
    let side_id = side["id"].as_str().unwrap().to_string();
    services
        .dispatch(
            "sessions.send",
            json!({ "sessionId": side_id, "text": "侧边快速提问" }),
        )
        .await
        .unwrap();
    assert!(store.session(&side_id).unwrap().is_some());

    services
        .dispatch(
            "instances.upsert",
            json!({
                "id": "codex-cli",
                "kind": "codex-cli",
                "displayName": "Codex 默认改名",
                "enabled": true,
                "isolationMode": "hostDefault"
            }),
        )
        .await
        .unwrap();
    assert!(
        store.session(&side_id).unwrap().is_none(),
        "idle ephemeral side session must be discarded when its instance restarts"
    );
}

#[tokio::test]
async fn review_fixes_cover_queued_checkpoint_claude_switchback_rejected_rewind_fork_default_and_worktree_parent() {
    let (dir, store, script, services) = setup();
    let repos_parent = dir.path().join("repos");
    let repo = repos_parent.join("app");
    init_git_repo(&repo);

    let proj = services
        .dispatch("projects.add", json!({ "path": repo }))
        .await
        .unwrap();
    let project_id = proj["id"].as_str().unwrap().to_string();

    // 1. Issue 11: 工作树根目录允许选在项目上级目录（repos），仍拒绝项目目录本身（repos/app）与子目录（repos/app/wt）
    let ok_parent = services
        .dispatch("settings.setWorktrees", json!({ "root": repos_parent }))
        .await;
    assert!(ok_parent.is_ok(), "parent dir of project must be allowed: {ok_parent:?}");
    let err_same = services
        .dispatch("settings.setWorktrees", json!({ "root": repo }))
        .await;
    assert!(err_same.is_err(), "project dir itself must be rejected");
    let err_child = services
        .dispatch("settings.setWorktrees", json!({ "root": repo.join("wt") }))
        .await;
    assert!(err_child.is_err(), "subdirectory of project must be rejected");

    // 2. Issue 7: 从自定义实例分叉时，明确选择默认实例应落到默认实例（instance_id = None），而不是继承自定义实例
    services
        .dispatch(
            "instances.upsert",
            json!({
                "id": "codex-work",
                "kind": "codex-cli",
                "displayName": "Codex 工作号",
                "enabled": true,
                "isolationMode": "shadowHome"
            }),
        )
        .await
        .unwrap();
    let custom_task = services
        .dispatch(
            "tasks.create",
            json!({
                "projectId": project_id,
                "agent": "codex-cli",
                "instanceId": "codex-work",
                "prompt": "",
                "options": {}
            }),
        )
        .await
        .unwrap();
    let custom_task_id = custom_task["id"].as_str().unwrap().to_string();
    let custom_sid = custom_task["sessions"][0]["id"].as_str().unwrap().to_string();
    services
        .dispatch("sessions.send", json!({ "sessionId": custom_sid, "text": "自定义账号首轮" }))
        .await
        .unwrap();

    // 2a. 显式传默认实例 id (`"codex-cli"`)
    let forked_default_explicit = services
        .dispatch(
            "tasks.fork",
            json!({
                "taskId": custom_task_id,
                "agent": "codex-cli",
                "instanceId": "codex-cli"
            }),
        )
        .await
        .unwrap();
    let forked_explicit_sid = forked_default_explicit["sessions"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()["id"]
        .as_str()
        .unwrap();
    assert_eq!(
        store.session(forked_explicit_sid).unwrap().unwrap().instance_id,
        None,
        "explicit default instanceId must target default instance, not inherit codex-work"
    );

    // 2b. 仅传 `agent: "codex-cli"` 省略 `instanceId`（兼容旧前端/直调）也不应继承自定义实例
    let forked_default_omitted = services
        .dispatch(
            "tasks.fork",
            json!({
                "taskId": custom_task_id,
                "agent": "codex-cli"
            }),
        )
        .await
        .unwrap();
    let forked_omitted_sid = forked_default_omitted["sessions"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()["id"]
        .as_str()
        .unwrap();
    assert_eq!(
        store.session(forked_omitted_sid).unwrap().unwrap().instance_id,
        None
    );

    // 2c. 不传 `agent` 与 `instanceId`（快捷原样分叉）仍继承当前自定义实例
    let forked_same = services
        .dispatch("tasks.fork", json!({ "taskId": custom_task_id }))
        .await
        .unwrap();
    let forked_same_sid = forked_same["sessions"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()["id"]
        .as_str()
        .unwrap();
    assert_eq!(
        store.session(forked_same_sid).unwrap().unwrap().instance_id.as_deref(),
        Some("codex-work")
    );

    // 清理分叉任务以免影响后续同目录文件恢复校验
    for id in [
        custom_task_id,
        forked_default_explicit["id"].as_str().unwrap().to_string(),
        forked_default_omitted["id"].as_str().unwrap().to_string(),
        forked_same["id"].as_str().unwrap().to_string(),
    ] {
        services
            .dispatch("tasks.remove", json!({ "id": id }))
            .await
            .unwrap();
    }

    // 3. Issue 4: 原生队列自动发出的回合绝不在事后伪造 pre_ref，禁止带污染快照回退文件，但首轮仍可完整回退
    let q_task = services
        .dispatch(
            "tasks.create",
            json!({
                "projectId": project_id,
                "agent": "codex-cli",
                "prompt": "",
                "options": {}
            }),
        )
        .await
        .unwrap();
    let q_task_id = q_task["id"].as_str().unwrap().to_string();
    let q_sid = q_task["sessions"][0]["id"].as_str().unwrap().to_string();
    *script.worktree_action.lock().unwrap() = Some(Box::new(|cwd: &Path| {
        fs::write(cwd.join("app.txt"), "turn1-write\n").unwrap();
    }));
    *script.auto_queued_turn.lock().unwrap() = Some((
        "原生队列自动发出的第2轮".into(),
        "turn2-already-written\n".into(),
    ));
    services
        .dispatch("sessions.send", json!({ "sessionId": q_sid, "text": "第1轮普通消息" }))
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    let q_cps = loop {
        let cps = store.session_checkpoints(&q_sid).unwrap();
        if cps.len() == 2 && cps[1].post_ref.is_some() {
            break cps;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for queued turn checkpoint post_ref: {cps:?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    };
    *script.worktree_action.lock().unwrap() = None;

    assert_eq!(q_cps.len(), 2);
    assert!(q_cps[0].pre_ref.is_some());
    assert!(
        q_cps[1].pre_ref.is_none(),
        "auto-dispatched queued turn must not fabricate a post-start pre_ref"
    );

    let q2_preview: RewindPreview = serde_json::from_value(
        services
            .dispatch(
                "sessions.rewindPreview",
                json!({ "sessionId": q_sid, "userEventId": q_cps[1].user_event_id }),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(!q2_preview.can_restore_files);
    assert!(q2_preview.file_restore_disabled_reason.is_some());

    // 首轮仍允许恢复文件，并把磁盘完整还原回 v0
    let q1_preview: RewindPreview = serde_json::from_value(
        services
            .dispatch(
                "sessions.rewindPreview",
                json!({ "sessionId": q_sid, "userEventId": q_cps[0].user_event_id }),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(q1_preview.can_restore_files);
    assert!(!q1_preview.has_manual_edits_warning);

    // 4. Issue 6: 回退请求被拒绝时（如预览后同目录出现其它任务活动），不能先删除侧边对话及草稿
    let side = services
        .dispatch(
            "tasks.openSide",
            json!({ "taskId": q_task_id, "agent": "codex-cli", "options": {} }),
        )
        .await
        .unwrap();
    let side_id = side["id"].as_str().unwrap().to_string();
    let side_draft = json!({ "text": "未发送侧边草稿" });
    store
        .set_draft(&side_id, Some(&side_draft), 100)
        .unwrap();

    // 同目录创建另一个任务并活动，导致 q_task 的文件回退被安全门控拒绝
    let blocker = services
        .dispatch(
            "tasks.create",
            json!({
                "projectId": project_id,
                "agent": "codex-cli",
                "prompt": "",
                "options": {}
            }),
        )
        .await
        .unwrap();
    let blocker_id = blocker["id"].as_str().unwrap().to_string();
    let blocker_sid = blocker["sessions"][0]["id"].as_str().unwrap().to_string();
    services
        .dispatch("sessions.send", json!({ "sessionId": blocker_sid, "text": "同目录并发活动" }))
        .await
        .unwrap();

    let rejected_files = services
        .dispatch(
            "sessions.rewind",
            json!({
                "sessionId": q_sid,
                "userEventId": q_cps[0].user_event_id,
                "restoreFiles": true
            }),
        )
        .await;
    assert!(rejected_files.is_err());
    assert!(
        store.session(&side_id).unwrap().is_some(),
        "side session must survive rejected file-restore rewind"
    );
    assert_eq!(
        store.draft(&side_id).unwrap(),
        Some(side_draft),
        "side draft must survive rejected rewind"
    );

    let rejected_missing = services
        .dispatch(
            "sessions.rewind",
            json!({
                "sessionId": q_sid,
                "userEventId": "non-existent-event-id",
                "restoreFiles": false
            }),
        )
        .await;
    assert!(rejected_missing.is_err());
    assert!(store.session(&side_id).unwrap().is_some());

    services
        .dispatch("tasks.remove", json!({ "id": blocker_id }))
        .await
        .unwrap();
    services
        .dispatch("tasks.remove", json!({ "id": q_task_id }))
        .await
        .unwrap();

    // 5. Issue 5: Claude 完成第 1 轮 -> 切换 Codex -> 切回 Claude（复用原生会话）完成第 2、3 轮 -> 回退第 3 轮时 kept_turns 必须为 2
    script.rewound.lock().unwrap().clear();
    let c_task = services
        .dispatch(
            "tasks.create",
            json!({
                "projectId": project_id,
                "agent": "claude-code",
                "prompt": "",
                "options": {}
            }),
        )
        .await
        .unwrap();
    let c_task_id = c_task["id"].as_str().unwrap().to_string();
    let c_seg0 = c_task["sessions"][0]["id"].as_str().unwrap().to_string();
    services
        .dispatch("sessions.send", json!({ "sessionId": c_seg0, "text": "Claude 第1轮" }))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // 切到 Codex 做一轮
    let switched_codex = services
        .dispatch(
            "tasks.switchAgent",
            json!({ "taskId": c_task_id, "agent": "codex-cli", "options": {} }),
        )
        .await
        .unwrap();
    let c_seg1 = switched_codex["sessions"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    services
        .dispatch("sessions.send", json!({ "sessionId": c_seg1, "text": "Codex 中间一轮" }))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // 切回 Claude（Delta 复用原生会话）完成第 2、3 轮
    let switched_back = services
        .dispatch(
            "tasks.switchAgent",
            json!({ "taskId": c_task_id, "agent": "claude-code", "options": {} }),
        )
        .await
        .unwrap();
    let c_seg2 = switched_back["sessions"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    services
        .dispatch("sessions.send", json!({ "sessionId": c_seg2, "text": "Claude 第2轮" }))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    services
        .dispatch("sessions.send", json!({ "sessionId": c_seg2, "text": "Claude 第3轮" }))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let seg2_events = store.events_since(&c_seg2, 0).unwrap();
    let q3_event_id = seg2_events
        .iter()
        .find_map(|s| match &s.event.body {
            SessionEventBody::UserMessage { text, .. } if text == "Claude 第3轮" => {
                Some(s.event.id.clone())
            }
            _ => None,
        })
        .unwrap();
    let q2_event_id = seg2_events
        .iter()
        .find_map(|s| match &s.event.body {
            SessionEventBody::UserMessage { text, .. } if text == "Claude 第2轮" => {
                Some(s.event.id.clone())
            }
            _ => None,
        })
        .unwrap();

    // 回退第 3 轮：原生 Claude 记录必须保留第 1 轮 + 第 2 轮（kept_turns = 2）
    services
        .dispatch(
            "sessions.rewind",
            json!({
                "sessionId": c_seg2,
                "userEventId": q3_event_id,
                "restoreFiles": false
            }),
        )
        .await
        .unwrap();
    {
        let rewound = script.rewound.lock().unwrap();
        assert_eq!(rewound.len(), 1);
        assert_eq!(
            rewound[0].2, 2,
            "rewinding turn 3 after switching back to Claude must keep turn 1 + turn 2 (2 turns)"
        );
    }

    // 再继续回退第 2 轮：原生 Claude 记录应保留 Seg0 的第 1 轮（kept_turns = 1），且 Delta Handoff 重置为未投递
    services
        .dispatch(
            "sessions.rewind",
            json!({
                "sessionId": c_seg2,
                "userEventId": q2_event_id,
                "restoreFiles": false
            }),
        )
        .await
        .unwrap();
    {
        let rewound = script.rewound.lock().unwrap();
        assert_eq!(rewound.len(), 2);
        assert_eq!(
            rewound[1].2, 1,
            "rewinding turn 2 after switching back to Claude must still keep Seg0's turn 1"
        );
    }
    let after_q2 = store.events_since(&c_seg2, 0).unwrap();
    assert!(
        after_q2.iter().any(|s| matches!(
            s.event.body,
            SessionEventBody::Handoff {
                strategy: aiwb_core::models::HandoffStrategy::Delta,
                delivered: false,
                ..
            }
        )),
        "Delta handoff should be reopened to delivered: false when its first turn is rewound"
    );
}

#[tokio::test]
async fn round2_review_fixes_cover_merge_guard_failed_restore_side_preservation_and_deleted_custom_instance() {
    let (dir, store, script, services) = setup();
    let repo = dir.path().join("repo-round2");
    init_git_repo(&repo);

    let proj = services
        .dispatch("projects.add", json!({ "path": repo }))
        .await
        .unwrap();
    let project_id = proj["id"].as_str().unwrap().to_string();

    // 1. Issue 4: 校验通过但实际 Git 恢复失败（如 index.lock）时，不能删除侧边聊天及草稿；解锁后重试应成功并清理侧边聊天
    let task = services
        .dispatch(
            "tasks.create",
            json!({
                "projectId": project_id,
                "agent": "codex-cli",
                "prompt": "",
                "options": {}
            }),
        )
        .await
        .unwrap();
    let task_id = task["id"].as_str().unwrap().to_string();
    let sid = task["sessions"][0]["id"].as_str().unwrap().to_string();
    let initial_content = fs::read_to_string(repo.join("app.txt")).unwrap();

    *script.worktree_action.lock().unwrap() = Some(Box::new(|cwd: &Path| {
        fs::write(cwd.join("app.txt"), "turn1-modified\n").unwrap();
    }));
    services
        .dispatch("sessions.send", json!({ "sessionId": sid, "text": "修改 app.txt" }))
        .await
        .unwrap();
    *script.worktree_action.lock().unwrap() = None;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    let cp = loop {
        let cps = store.session_checkpoints(&sid).unwrap();
        if let Some(first) = cps.first() {
            if first.post_ref.is_some() {
                break first.clone();
            }
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    };

    let side = services
        .dispatch("tasks.openSide", json!({ "taskId": task_id }))
        .await
        .unwrap();
    let side_id = side["id"].as_str().unwrap().to_string();
    let side_draft = json!({ "text": "恢复失败时必须保住的侧边草稿" });
    store.set_draft(&side_id, Some(&side_draft), 200).unwrap();

    // 预览此时允许恢复文件
    let ok_preview: RewindPreview = serde_json::from_value(
        services
            .dispatch(
                "sessions.rewindPreview",
                json!({ "sessionId": sid, "userEventId": cp.user_event_id }),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(ok_preview.can_restore_files);

    // 模拟另一个 Git 进程持有 index.lock，使实际 restore_checkpoint 在 read-tree 阶段失败
    let index_lock = repo.join(".git").join("index.lock");
    fs::write(&index_lock, "locked").unwrap();
    let failed_rewind = services
        .dispatch(
            "sessions.rewind",
            json!({
                "sessionId": sid,
                "userEventId": cp.user_event_id,
                "restoreFiles": true
            }),
        )
        .await;
    assert!(
        failed_rewind.is_err(),
        "rewind with restoreFiles must fail while index.lock exists"
    );
    assert!(
        store.session(&side_id).unwrap().is_some(),
        "side session must not be deleted when git restore fails"
    );
    assert_eq!(
        store.draft(&side_id).unwrap(),
        Some(side_draft.clone()),
        "side draft must not be deleted when git restore fails"
    );
    fs::remove_file(&index_lock).unwrap();

    // 2. Issue 3 (daemon 侧预览门控): 存在未完成的合并（MERGE_HEAD）时，预览必须禁用文件恢复
    let run_git = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    };
    run_git(&["checkout", "-b", "merge-branch"]);
    fs::write(repo.join("branch.txt"), "from-branch\n").unwrap();
    run_git(&["add", "branch.txt"]);
    run_git(&["commit", "-m", "branch commit"]);
    run_git(&["checkout", "-"]);
    run_git(&["merge", "--no-ff", "--no-commit", "merge-branch"]);

    let merge_preview: RewindPreview = serde_json::from_value(
        services
            .dispatch(
                "sessions.rewindPreview",
                json!({ "sessionId": sid, "userEventId": cp.user_event_id }),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(
        !merge_preview.can_restore_files,
        "file restore must be disabled during active MERGE_HEAD"
    );
    assert!(merge_preview.file_restore_disabled_reason.is_some());

    // 中止合并并清理临时分支后，再次执行回退应成功还原文件并丢弃侧边聊天
    run_git(&["merge", "--abort"]);
    run_git(&["branch", "-D", "merge-branch"]);

    services
        .dispatch(
            "sessions.rewind",
            json!({
                "sessionId": sid,
                "userEventId": cp.user_event_id,
                "restoreFiles": true
            }),
        )
        .await
        .unwrap();
    assert_eq!(fs::read_to_string(repo.join("app.txt")).unwrap(), initial_content);
    assert!(
        store.session(&side_id).unwrap().is_none(),
        "side session should be discarded once rewind succeeds"
    );

    // 3. Issue 5: 删除自定义实例后，绑定该实例的旧任务（含未发过首条消息与已发过消息的任务）
    // 发送或原样分叉时绝不能静默回退到默认账号，但允许通过切换实例恢复使用。
    services
        .dispatch(
            "instances.upsert",
            json!({
                "id": "codex-ephemeral",
                "kind": "codex-cli",
                "displayName": "Codex 临时账号",
                "enabled": true,
                "isolationMode": "shadowHome"
            }),
        )
        .await
        .unwrap();

    let unsent = services
        .dispatch(
            "tasks.create",
            json!({
                "projectId": project_id,
                "agent": "codex-cli",
                "instanceId": "codex-ephemeral",
                "prompt": "",
                "options": {}
            }),
        )
        .await
        .unwrap();
    let unsent_task_id = unsent["id"].as_str().unwrap().to_string();
    let unsent_sid = unsent["sessions"][0]["id"].as_str().unwrap().to_string();

    let spoken = services
        .dispatch(
            "tasks.create",
            json!({
                "projectId": project_id,
                "agent": "codex-cli",
                "instanceId": "codex-ephemeral",
                "prompt": "",
                "options": {}
            }),
        )
        .await
        .unwrap();
    let spoken_task_id = spoken["id"].as_str().unwrap().to_string();
    let spoken_sid = spoken["sessions"][0]["id"].as_str().unwrap().to_string();
    services
        .dispatch(
            "sessions.send",
            json!({ "sessionId": spoken_sid, "text": "临时账号首轮" }),
        )
        .await
        .unwrap();

    // 删除该自定义实例
    let removed = services
        .dispatch(
            "instances.remove",
            json!({ "id": "codex-ephemeral", "deleteData": false }),
        )
        .await
        .unwrap();
    assert_eq!(removed.as_bool(), Some(true));

    let sent_before = script.sent.lock().unwrap().len();
    let err_unsent = services
        .dispatch(
            "sessions.send",
            json!({ "sessionId": unsent_sid, "text": "不应误发给默认账号" }),
        )
        .await;
    assert!(
        err_unsent.is_err(),
        "unsent task referencing deleted custom instance must fail instead of falling back to default"
    );
    let err_spoken = services
        .dispatch(
            "sessions.send",
            json!({ "sessionId": spoken_sid, "text": "已发过消息的旧任务也不应回退默认账号" }),
        )
        .await;
    assert!(
        err_spoken.is_err(),
        "spoken task referencing deleted custom instance must fail instead of falling back to default"
    );
    assert_eq!(
        script.sent.lock().unwrap().len(),
        sent_before,
        "deleted custom instance tasks must never invoke the default adapter"
    );

    // 原样分叉也会被拒绝，不会静默落到默认账号
    let err_fork = services
        .dispatch("tasks.fork", json!({ "taskId": spoken_task_id }))
        .await;
    assert!(err_fork.is_err());

    // 用户显式切到有效实例（如默认实例）后，两个任务都可正常恢复对话
    services
        .dispatch(
            "tasks.switchAgent",
            json!({
                "taskId": unsent_task_id,
                "agent": "codex-cli",
                "instanceId": "codex-cli",
                "options": {}
            }),
        )
        .await
        .unwrap();
    services
        .dispatch(
            "sessions.send",
            json!({ "sessionId": unsent_sid, "text": "切换后正常发送" }),
        )
        .await
        .unwrap();

    let rescued = services
        .dispatch(
            "tasks.switchAgent",
            json!({
                "taskId": spoken_task_id,
                "agent": "codex-cli",
                "instanceId": "codex-cli",
                "options": {}
            }),
        )
        .await
        .unwrap();
    let rescued_sid = rescued["sessions"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    services
        .dispatch(
            "sessions.send",
            json!({ "sessionId": rescued_sid, "text": "已发过消息的任务切换后正常续聊" }),
        )
        .await
        .unwrap();
    assert_eq!(script.sent.lock().unwrap().len(), sent_before + 2);

    // 4. Issue 6: 会话正在运行时触发文件回退，若因 `index.lock` 恢复失败，会话状态必须同步收敛为 `Stopped`，不能卡在“运行中”。
    *script.stay_running.lock().unwrap() = true;
    *script.worktree_action.lock().unwrap() = Some(Box::new(|cwd: &Path| {
        fs::write(cwd.join("app.txt"), "running-turn-change\n").unwrap();
    }));
    services
        .dispatch(
            "sessions.send",
            json!({ "sessionId": sid, "text": "进行中的长回合" }),
        )
        .await
        .unwrap();
    *script.worktree_action.lock().unwrap() = None;
    *script.stay_running.lock().unwrap() = false;

    let running_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if store.session(&sid).unwrap().unwrap().status == SessionStatus::Running {
            break;
        }
        assert!(tokio::time::Instant::now() < running_deadline);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let running_cp = store
        .session_checkpoints(&sid)
        .unwrap()
        .last()
        .unwrap()
        .clone();

    fs::write(&index_lock, "locked-while-running").unwrap();
    let err_running_rewind = services
        .dispatch(
            "sessions.rewind",
            json!({
                "sessionId": sid,
                "userEventId": running_cp.user_event_id,
                "restoreFiles": true
            }),
        )
        .await;
    assert!(err_running_rewind.is_err());

    assert_eq!(
        store.session(&sid).unwrap().unwrap().status,
        SessionStatus::Stopped,
        "running session stopped before failed file restore must transition to Stopped"
    );
    let listed_tasks = services.dispatch("tasks.list", json!(null)).await.unwrap();
    let task_item = listed_tasks
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"].as_str() == Some(task_id.as_str()))
        .unwrap();
    assert_eq!(task_item["sessions"][0]["status"].as_str(), Some("stopped"));
    assert_eq!(task_item["attention"]["state"].as_str(), Some("idle"));

    fs::remove_file(&index_lock).unwrap();
    services
        .dispatch(
            "sessions.rewind",
            json!({
                "sessionId": sid,
                "userEventId": running_cp.user_event_id,
                "restoreFiles": true
            }),
        )
        .await
        .unwrap();
    assert_eq!(fs::read_to_string(repo.join("app.txt")).unwrap(), initial_content);
}
