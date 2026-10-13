//! Codex 会话目录：`thread/list` 等同于 `codex resume --all`。
//!
//! 实现 [`SessionDirectory`](crate::features::agents::directory::SessionDirectory)。
//! 会话 id 就是 Codex thread id。本模块只负责列出线程；真正恢复用
//! `thread/resume`，历史用 `thread/turns/list`。
//!
//! `codex resume --all` 关闭 cwd 过滤，但仍只显示交互会话（不含
//! `--include-non-interactive`，也不含已归档）。这与 app-server
//! `thread/list` 在省略 `sourceKinds`、`archived: false`、不传 `cwd` 时的
//! 结果是同一份列表。`~/.codex/session_index.jsonl` 只有 id / 标题，没有
//! cwd，而且和这份列表对不齐，所以不能当来源。
//!
//! 会话 id 就是 Codex thread id。本模块只负责列出线程；真正恢复用
//! `thread/resume`，历史用 `thread/turns/list`。

use std::sync::{Arc, OnceLock};
#[cfg(test)]
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
#[cfg(test)]
use tokio::time::timeout;

use async_trait::async_trait;

use crate::features::agents::directory::{cwd_key, DirectoryEntry, SessionDirectory};
use crate::models::{strip_verbatim_prefix, SessionStatus};
#[cfg(test)]
use crate::models::SessionEventBody;

use super::directory_client::RpcClient;

const CACHE_TTL: Duration = Duration::from_secs(8);

pub struct CodexDirectory {
    inner: tokio::sync::Mutex<DirectoryState>,
}

struct DirectoryState {
    client: Option<RpcClient>,
    active: Option<Cache>,
    generation: u64,
}

struct Cache {
    at: Instant,
    result: Result<Vec<DirectoryEntry>, String>,
}

impl CodexDirectory {
    pub fn new() -> Self {
        Self {
            inner: tokio::sync::Mutex::new(DirectoryState {
                client: None,
                active: None,
                generation: 0,
            }),
        }
    }

    /// 侧边栏列表和生命周期 RPC 共用一个 app-server。
    pub fn shared() -> Arc<Self> {
        static DIR: OnceLock<Arc<CodexDirectory>> = OnceLock::new();
        DIR.get_or_init(|| Arc::new(CodexDirectory::new())).clone()
    }

    pub async fn invalidate(&self) {
        let mut state = self.inner.lock().await;
        state.active = None;
        state.generation = state.generation.wrapping_add(1);
    }

    /// 交互、未归档的全部线程。短时间内复用上一次结果，避免每个项目都拉起进程。
    pub async fn list_threads(&self) -> Result<Vec<DirectoryEntry>, String> {
        let mut state = self.inner.lock().await;
        if let Some(cache) = &state.active {
            if cache.at.elapsed() < CACHE_TTL {
                return cache.result.clone();
            }
        }
        let generation = state.generation;
        let result = fetch_threads(&mut state.client, false).await;
        if state.generation == generation {
            state.active = Some(Cache {
                at: Instant::now(),
                result: result.clone(),
            });
        }
        result
    }

    pub async fn rename_thread(&self, native_id: &str, name: &str) -> Result<(), String> {
        self.rpc(
            "thread/name/set",
            json!({ "threadId": native_id, "name": name }),
        )
        .await?;
        self.invalidate().await;
        Ok(())
    }

    pub async fn delete_thread(&self, native_id: &str) -> Result<(), String> {
        self.rpc("thread/delete", json!({ "threadId": native_id }))
            .await?;
        self.invalidate().await;
        Ok(())
    }

    /// 桌面端参数：`excludeTurns: true` 只缩小回包，历史仍会复制。
    ///
    /// 不用常驻目录进程：它调用 `thread/fork` 后会成为新线程的 active writer，
    /// 随后会话里的 `thread/resume` 只能只读打开。
    pub async fn fork_thread(&self, native_id: &str) -> Result<DirectoryEntry, String> {
        let client = RpcClient::spawn().await?;
        let result = client
            .request(
                "thread/fork",
                json!({
                    "threadId": native_id,
                    "excludeTurns": true,
                    "threadSource": "user",
                }),
                Duration::from_secs(60),
            )
            .await;
        client.shutdown().await;
        let result = result?;
        let thread = result.get("thread").cloned().unwrap_or(result);
        let entry = parse_thread(&thread).ok_or_else(|| "创建聊天分支失败".to_string())?;
        self.invalidate().await;
        Ok(entry)
    }

    #[allow(dead_code)]
    #[cfg(test)]
    pub async fn read_cwd(&self, native_id: &str) -> Result<String, String> {
        let result = self
            .rpc(
                "thread/read",
                json!({ "threadId": native_id, "includeTurns": false }),
            )
            .await?;
        cwd_from_thread_payload(&result).ok_or_else(|| "无法读取聊天目录".to_string())
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut state = self.inner.lock().await;
        rpc_retry(&mut state.client, method, params).await
    }
}

impl Default for CodexDirectory {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SessionDirectory for CodexDirectory {
    fn kind(&self) -> crate::models::AgentKind {
        crate::models::AgentKind::CodexCli
    }

    async fn list(&self) -> Result<Vec<DirectoryEntry>, String> {
        self.list_threads().await
    }

    async fn invalidate(&self) {
        CodexDirectory::invalidate(self).await
    }
}

async fn fetch_threads(
    client: &mut Option<RpcClient>,
    archived: bool,
) -> Result<Vec<DirectoryEntry>, String> {
    let mut last_err = String::from("无法读取 Codex 会话");
    for attempt in 0..2 {
        if client.is_none() {
            *client = Some(RpcClient::spawn().await?);
        }
        match client.as_ref().unwrap().list_pages(archived).await {
            Ok(threads) => return Ok(threads),
            Err(err) => {
                *client = None;
                last_err = err;
                if attempt == 1 {
                    break;
                }
            }
        }
    }
    Err(last_err)
}

async fn rpc_retry(
    client: &mut Option<RpcClient>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let mut last_err = format!("无法调用 Codex {method}");
    for attempt in 0..2 {
        if client.is_none() {
            *client = Some(RpcClient::spawn().await?);
        }
        match client
            .as_ref()
            .unwrap()
            .request(method, params.clone(), Duration::from_secs(60))
            .await
        {
            Ok(value) => return Ok(value),
            Err(err) => {
                *client = None;
                last_err = err;
                if attempt == 1 {
                    break;
                }
            }
        }
    }
    Err(last_err)
}

#[allow(dead_code)]
#[cfg(test)]
fn cwd_from_thread_payload(value: &Value) -> Option<String> {
    let thread = value.get("thread").unwrap_or(value);
    let cwd = strip_verbatim_prefix(thread.get("cwd").and_then(Value::as_str).unwrap_or(""));
    if cwd.is_empty() {
        None
    } else {
        Some(cwd)
    }
}

pub fn thread_title(name: Option<&str>, preview: Option<&str>) -> String {
    let name = name.unwrap_or("").trim();
    if !name.is_empty() {
        return super::history::take_chars(name, 48);
    }
    let preview = preview.unwrap_or("").trim();
    let line = preview.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        "未命名会话".into()
    } else {
        super::history::take_chars(line, 48)
    }
}

pub fn status_from_thread(status: &Value) -> SessionStatus {
    let kind = status.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "systemError" => SessionStatus::Failed,
        "active" => {
            let waiting = status
                .get("activeFlags")
                .and_then(Value::as_array)
                .map(|flags| {
                    flags.iter().any(|flag| {
                        matches!(
                            flag.as_str(),
                            Some("waitingOnApproval" | "waitingOnUserInput")
                        )
                    })
                })
                .unwrap_or(false);
            if waiting {
                SessionStatus::NeedsInput
            } else {
                SessionStatus::Running
            }
        }
        _ => SessionStatus::Completed,
    }
}

pub fn parse_thread(value: &Value) -> Option<DirectoryEntry> {
    let id = value.get("id").and_then(Value::as_str)?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    let cwd = strip_verbatim_prefix(value.get("cwd").and_then(Value::as_str).unwrap_or(""));
    let ephemeral = value
        .get("ephemeral")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let archived = value
        .get("archived")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(DirectoryEntry {
        native_id: id,
        cwd_key: cwd_key(&cwd),
        cwd,
        title: thread_title(
            value.get("name").and_then(Value::as_str),
            value.get("preview").and_then(Value::as_str),
        ),
        created_at: unix_millis(value.get("createdAt")),
        updated_at: unix_millis(value.get("updatedAt")),
        status: status_from_thread(value.get("status").unwrap_or(&Value::Null)),
        ephemeral,
        archived,
    })
}

fn unix_millis(value: Option<&Value>) -> i64 {
    let Some(value) = value else {
        return 0;
    };
    let raw = value
        .as_i64()
        .or_else(|| value.as_f64().map(|n| n as i64))
        .unwrap_or(0);
    if raw > 10_000_000_000 {
        raw
    } else {
        raw.saturating_mul(1000)
    }
}

#[cfg(test)]
pub(super) async fn delete_persisted_thread(thread_id: &str) -> Result<(), String> {
    let client = RpcClient::spawn().await?;
    let deleted = client
        .request(
            "thread/delete",
            json!({ "threadId": thread_id }),
            std::time::Duration::from_secs(30),
        )
        .await;
    drop(client);
    deleted.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn title_prefers_name_then_preview() {
        assert_eq!(
            thread_title(Some("概括当前项目"), Some("别的")),
            "概括当前项目"
        );
        assert_eq!(thread_title(Some("  "), Some("第一行\n第二行")), "第一行");
        assert_eq!(thread_title(None, Some("   ")), "未命名会话");
    }

    #[test]
    fn status_maps_active_flags() {
        assert_eq!(
            status_from_thread(&json!({"type": "idle"})),
            SessionStatus::Completed
        );
        assert_eq!(
            status_from_thread(&json!({"type": "notLoaded"})),
            SessionStatus::Completed
        );
        assert_eq!(
            status_from_thread(&json!({"type": "systemError"})),
            SessionStatus::Failed
        );
        assert_eq!(
            status_from_thread(&json!({"type": "active", "activeFlags": ["waitingOnApproval"]})),
            SessionStatus::NeedsInput
        );
        assert_eq!(
            status_from_thread(&json!({"type": "active", "activeFlags": []})),
            SessionStatus::Running
        );
    }

    #[test]
    fn parse_thread_reads_archived() {
        let thread = parse_thread(&json!({
            "id": "abc",
            "cwd": r"F:\app",
            "archived": true,
            "name": "已归档",
        }))
        .expect("thread");
        assert!(thread.archived);
        assert_eq!(thread.title, "已归档");
        let plain = parse_thread(&json!({"id": "def", "cwd": r"F:\app"})).expect("plain");
        assert!(!plain.archived);
    }

    #[test]
    fn parses_thread_list_item_without_using_a_local_id() {
        let parsed = parse_thread(&json!({
            "id": "01a12492-d8e5-7e40-b438-95315ee95f7c",
            "cwd": r"\\?\F:\mercury_resource\client\mercury_dev",
            "preview": "概括当前项目",
            "name": "概括当前项目",
            "ephemeral": false,
            "createdAt": 1_791_616_756_i64,
            "updatedAt": 1_791_616_800_i64,
            "status": { "type": "notLoaded" }
        }))
        .unwrap();
        assert_eq!(parsed.native_id, "01a12492-d8e5-7e40-b438-95315ee95f7c");
        assert_eq!(parsed.cwd, r"F:\mercury_resource\client\mercury_dev");
        assert_eq!(parsed.title, "概括当前项目");
        assert_eq!(parsed.created_at, 1_791_616_756_000);
        assert_eq!(parsed.status, SessionStatus::Completed);
    }

    #[tokio::test]
    #[ignore = "calls the local Codex CLI"]
    async fn lists_interactive_resume_threads() {
        let directory = CodexDirectory::new();
        let threads = directory.list_threads().await.expect("thread/list");
        assert!(
            !threads.is_empty(),
            "codex resume --all equivalent list was empty"
        );
        assert!(threads.iter().all(|thread| !thread.native_id.is_empty()));
        assert!(threads.iter().all(|thread| !thread.ephemeral));
        let again = directory.list_threads().await.expect("cached");
        assert_eq!(again.len(), threads.len());
        eprintln!("interactive resume threads: {}", threads.len());
    }

    #[tokio::test]
    #[ignore = "calls the local Codex CLI"]
    async fn resumes_an_existing_thread_by_its_id() {
        use crate::features::agents::codex::CodexCliAdapter;
        use crate::features::agents::{AgentAdapter, SessionContext};
        use tokio::sync::mpsc;

        let directory = CodexDirectory::new();
        let threads = directory.list_threads().await.expect("thread/list");
        let thread = threads
            .iter()
            .rev()
            .find(|thread| !thread.cwd.is_empty())
            .expect("resume list has a thread");
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = CodexCliAdapter::new()
            .start_session(
                SessionContext {
                    project_path: thread.cwd.clone(),
                    access_mode: None,
                    resume_native_id: Some(thread.native_id.clone()),
                    options: serde_json::json!({ "persist": true }),
                },
                tx,
            )
            .await
            .expect("resume");
        assert_eq!(
            session.native_id().as_deref(),
            Some(thread.native_id.as_str())
        );
        let mut saw_history = false;
        while let Ok(body) = rx.try_recv() {
            if matches!(
                body,
                SessionEventBody::UserMessage { .. } | SessionEventBody::AgentMessage { .. }
            ) {
                saw_history = true;
            }
        }
        let _ = session.stop().await;
        assert!(saw_history, "resumed thread did not load any messages");
    }

    #[tokio::test]
    #[ignore = "calls the local Codex CLI"]
    async fn persistent_start_shows_up_in_resume_list_then_is_deleted() {
        use crate::features::agents::codex::CodexCliAdapter;
        use crate::features::agents::{AgentAdapter, SessionContext};
        use tokio::sync::mpsc;

        let dir = std::env::temp_dir().join(format!("ai-workbench-resume-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp cwd");
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = CodexCliAdapter::new()
            .start_session(
                SessionContext {
                    project_path: dir.display().to_string(),
                    access_mode: Some("full".into()),
                    resume_native_id: None,
                    options: serde_json::json!({ "persist": true }),
                },
                tx,
            )
            .await
            .expect("thread/start");
        let id = session.native_id().expect("native thread id");
        assert!(!id.is_empty());
        let send = session
            .send_message("Reply with the single word ok. Do not use tools.".into())
            .await;
        let mut saw_reply = false;
        if send.is_ok() {
            let deadline = std::time::Instant::now() + Duration::from_secs(90);
            while std::time::Instant::now() < deadline {
                match timeout(Duration::from_millis(500), rx.recv()).await {
                    Ok(Some(SessionEventBody::AgentMessage { text, .. }))
                        if !text.trim().is_empty() =>
                    {
                        saw_reply = true;
                        break;
                    }
                    Ok(Some(SessionEventBody::Error { message })) => {
                        panic!("codex turn failed: {message}");
                    }
                    Ok(None) => break,
                    _ => {}
                }
            }
        }

        let directory = CodexDirectory::new();
        let listed = directory.list_threads().await;
        let found = listed
            .as_ref()
            .map(|threads| threads.iter().any(|thread| thread.native_id == id))
            .unwrap_or(false);
        let _ = session.stop().await;

        let client = RpcClient::spawn().await.expect("delete client");
        let deleted = client
            .request(
                "thread/delete",
                json!({ "threadId": id }),
                Duration::from_secs(30),
            )
            .await;
        drop(client);
        let _ = std::fs::remove_dir_all(&dir);

        assert!(send.is_ok(), "send failed: {send:?}");
        assert!(saw_reply, "Codex did not answer");
        assert!(listed.is_ok(), "thread/list failed: {listed:?}");
        assert!(found, "new thread {id} is missing from codex resume list");
        deleted.expect("thread/delete");
    }

    const GAP_LIFECYCLE: &str = r"C:\Users\admin\Desktop\temp\ai-workbench-project\_gap-lifecycle";

    struct GapCleanup {
        ids: Arc<Mutex<Vec<String>>>,
    }

    impl Drop for GapCleanup {
        fn drop(&mut self) {
            let ids = self.ids.lock().unwrap().clone();
            let handle = std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("cleanup runtime");
                runtime.block_on(cleanup_gap_threads(ids));
            });
            let _ = handle.join();
        }
    }

    fn gap_key() -> String {
        cwd_key(GAP_LIFECYCLE)
    }

    async fn cleanup_gap_threads(mut ids: Vec<String>) {
        let directory = CodexDirectory::new();
        if let Ok(active) = directory.list_threads().await {
            push_gap_prefixed(&mut ids, &active);
        }
        ids.sort();
        ids.dedup();
        for id in ids {
            let Ok(cwd) = directory.read_cwd(&id).await else {
                continue;
            };
            if cwd_key(&cwd) != gap_key() {
                continue;
            }
            let _ = directory.delete_thread(&id).await;
        }
    }

    fn push_gap_prefixed(ids: &mut Vec<String>, threads: &[DirectoryEntry]) {
        for thread in threads {
            if thread.cwd_key == gap_key() && thread.title.starts_with("gap-lifecycle-") {
                ids.push(thread.native_id.clone());
            }
        }
    }

    #[tokio::test]
    #[ignore = "calls the local Codex CLI against _gap-lifecycle only"]
    async fn gap_lifecycle_rename_fork_archive_delete() {
        use crate::features::agents::codex::CodexCliAdapter;
        use crate::features::agents::{AgentAdapter, SessionContext};
        use tokio::sync::mpsc;

        std::fs::create_dir_all(GAP_LIFECYCLE).expect("gap dir");
        let ids = Arc::new(Mutex::new(Vec::new()));
        let _cleanup = GapCleanup {
            ids: Arc::clone(&ids),
        };
        let name = format!(
            "gap-lifecycle-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
        let (tx, _rx) = mpsc::unbounded_channel();
        let session = CodexCliAdapter::new()
            .start_session(
                SessionContext {
                    project_path: GAP_LIFECYCLE.into(),
                    access_mode: Some("full".into()),
                    resume_native_id: None,
                    options: json!({ "persist": true }),
                },
                tx,
            )
            .await
            .expect("thread/start");
        let id = session.native_id().expect("native thread id");
        ids.lock().unwrap().push(id.clone());
        let _ = session.stop().await;

        let adapter = CodexCliAdapter::new();
        adapter
            .rename_thread(&id, &name)
            .await
            .expect("thread/name/set");
        let forked = adapter.fork_thread(&id).await.expect("thread/fork");
        ids.lock().unwrap().push(forked.native_id.clone());

        let directory = CodexDirectory::new();
        let fork_cwd = if forked.cwd_key == gap_key() && !forked.cwd.is_empty() {
            forked.cwd.clone()
        } else {
            directory
                .read_cwd(&forked.native_id)
                .await
                .expect("fork cwd")
        };
        assert_eq!(
            cwd_key(&fork_cwd),
            gap_key(),
            "fork left the gap project: {fork_cwd}"
        );

        directory.invalidate().await;
        let active = directory.list_threads().await.expect("active list");
        let row = active
            .iter()
            .find(|thread| thread.native_id == id)
            .expect("renamed thread missing");
        assert_eq!(row.title, name);

        for native in [id, forked.native_id] {
            let cwd = directory
                .read_cwd(&native)
                .await
                .expect("cwd before delete");
            assert_eq!(
                cwd_key(&cwd),
                gap_key(),
                "refusing to delete {native} at {cwd}"
            );
            adapter.delete_thread(&native).await.expect("thread/delete");
        }
        ids.lock().unwrap().clear();
    }

    #[tokio::test]
    #[ignore = "calls the local Codex CLI in _gap-history only"]
    async fn gap_history_replays_full_command_output_and_patch() {
        use crate::features::agents::codex::CodexCliAdapter;
        use crate::features::agents::{AgentAdapter, AgentSession, SessionContext};
        use tokio::sync::mpsc;

        const GAP_HISTORY: &str = r"C:\Users\admin\Desktop\temp\ai-workbench-project\_gap-history";
        std::fs::create_dir_all(GAP_HISTORY).expect("gap history dir");
        let expected_key = cwd_key(GAP_HISTORY);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let session = CodexCliAdapter::new()
            .start_session(
                SessionContext {
                    project_path: GAP_HISTORY.into(),
                    access_mode: Some("full".into()),
                    resume_native_id: None,
                    options: json!({ "persist": true }),
                },
                tx,
            )
            .await
            .expect("thread/start");
        let id = session.native_id().expect("native thread id");
        let cleanup = {
            let id = id.clone();
            let expected_key = expected_key.clone();
            move || {
                let id = id.clone();
                let expected_key = expected_key.clone();
                async move {
                    let directory = CodexDirectory::new();
                    let Ok(cwd) = directory.read_cwd(&id).await else {
                        return;
                    };
                    if cwd_key(&cwd) != expected_key {
                        return;
                    }
                    let _ = directory.delete_thread(&id).await;
                }
            }
        };
        while rx.try_recv().is_ok() {}
        let send = session
            .send_message(
                "只在当前目录做两件事，然后停止：\n\
                 1. 写入文件 gap-history.txt，内容只有 gap-history-marker。\n\
                 2. 原样执行 powershell -NoProfile -Command \"Write-Output (('A'*400)+'GAP-HISTORY-TAIL')\"。\n\
                 不要概括命令输出。"
                    .into(),
            )
            .await;
        assert!(send.is_ok(), "send failed: {send:?}");
        let deadline = std::time::Instant::now() + Duration::from_secs(180);
        let mut failed = None;
        let mut saw_running = false;
        let mut finished = false;
        while std::time::Instant::now() < deadline {
            match timeout(Duration::from_millis(500), rx.recv()).await {
                Ok(Some(SessionEventBody::Error { message })) => {
                    failed = Some(message);
                    break;
                }
                Ok(Some(SessionEventBody::StatusChanged {
                    status: SessionStatus::Running,
                })) => saw_running = true,
                Ok(Some(SessionEventBody::StatusChanged {
                    status: SessionStatus::Completed | SessionStatus::Failed,
                })) if saw_running => {
                    finished = true;
                    break;
                }
                Ok(None) => break,
                _ => {}
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        let _ = session.stop().await;
        if !saw_running || !finished || failed.is_some() {
            cleanup().await;
            assert!(saw_running, "turn never started");
            assert!(finished, "turn did not finish: {failed:?}");
            if let Some(message) = failed {
                panic!("codex turn failed: {message}");
            }
        }

        let (tx, mut rx) = mpsc::unbounded_channel();
        let resumed = CodexCliAdapter::new()
            .start_session(
                SessionContext {
                    project_path: GAP_HISTORY.into(),
                    access_mode: Some("full".into()),
                    resume_native_id: Some(id.clone()),
                    options: json!({ "persist": true }),
                },
                tx,
            )
            .await
            .expect("thread/resume");
        let mut history = Vec::new();
        while let Ok(body) = rx.try_recv() {
            history.push(body);
        }
        let (older, exhausted) = AgentSession::load_older_history(&*resumed)
            .await
            .expect("older history");
        let _ = resumed.stop().await;
        cleanup().await;

        assert!(
            history.iter().all(|body| !matches!(
                body,
                SessionEventBody::System { text } if text.contains("更早的 Codex 记录没有全部载入")
            )),
            "history was still truncated"
        );
        assert!(
            history.iter().any(|body| matches!(
                body,
                SessionEventBody::ToolCall { detail, .. } if detail.contains("GAP-HISTORY-TAIL")
            )),
            "resumed history dropped the command tail: {history:?}"
        );
        let written =
            std::fs::read_to_string(format!("{GAP_HISTORY}\\gap-history.txt")).unwrap_or_default();
        assert!(
            written.contains("gap-history-marker"),
            "gap-history.txt was not written: {written:?}"
        );
        assert!(
            history.iter().any(|body| match body {
                SessionEventBody::ToolCall {
                    summary, detail, ..
                } => {
                    summary.contains("gap-history.txt")
                        || detail.contains("gap-history.txt")
                        || detail.contains("gap-history-marker")
                }
                SessionEventBody::TurnDiff { diff, .. } => {
                    diff.contains("gap-history.txt") || diff.contains("gap-history-marker")
                }
                _ => false,
            }),
            "resumed history dropped the file write: {history:?}"
        );
        assert!(exhausted, "a one-turn thread still had another page");
        assert!(older.is_empty());
    }
}
