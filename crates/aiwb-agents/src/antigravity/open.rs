//! 打开一条 `agy acp` 会话。
//!
//! 启动顺序：`initialize` → `session/new`、`session/load` 或 `session/resume`。模型目录在打开的回包里，
//! 所以只探模型目录时也要建一条会话，用完连文件一起删掉。
//! 宿主已有时间线时用 `session/resume`，它不回放；要时间线时用 `session/load`，它把历史推完才回包。

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::catalog;
use super::directory;
use super::dialect::{AntigravityDialect, RULES};
use super::process;
use crate::acp::runtime::{mcp_servers, Opening, Parts, Shared, HANDSHAKE};
use crate::acp::UpdateRules;
use crate::{AgentError, DirectoryEntry, EventSink, WorkbenchMcp};
use aiwb_core::models::{cwd_key, SessionEventBody, SessionStatus};

/// 同一时刻只让一个 `agy acp` 走启动，并行时 `session/new` 会超时（2026-11-09，6 个同时起）。
fn startup_gate() -> &'static tokio::sync::Mutex<()> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::new(()))
}

const COMMANDS_POLL: Duration = Duration::from_millis(50);
const COMMANDS_POLLS: u32 = 60;

pub struct Open {
    pub project_path: String,
    pub access_mode: Option<String>,
    pub resume: Option<String>,
    pub persist: bool,
    pub replay_history: bool,
    pub workbench_mcp: Option<WorkbenchMcp>,
    pub roots: Vec<String>,
    pub saved_goal: Option<SessionEventBody>,
}

pub fn roots_of(options: &Value) -> Vec<String> {
    options
        .get("writable_roots")
        .and_then(Value::as_array)
        .map(|roots| {
            roots
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|root| !root.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub async fn open(options: Open, events: EventSink) -> Result<Arc<Shared>, AgentError> {
    let project = PathBuf::from(options.project_path.trim());
    if project.as_os_str().is_empty() {
        return Err(AgentError::Runtime("没有项目目录".into()));
    }
    let resume = options
        .resume
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    if let Some(id) = resume.as_deref() {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err(AgentError::Runtime(format!("无效的会话 id：{id}")));
        }
    }
    let program = process::resolve()?;
    let child = process::spawn(&program, &project)?;
    let probing = resume.is_none() && !options.persist;
    let access = options.access_mode.as_deref().unwrap_or("full");
    let servers = mcp_servers(options.workbench_mcp.as_ref());
    let dialect = AntigravityDialect::new(&project, events.clone(), probing, servers.clone());
    if let Some(id) = resume.as_deref() {
        dialect.resume_subagents(id, options.replay_history);
        dialect.restore_goal(options.saved_goal);
    }
    let access = {
        use crate::acp::Dialect;
        dialect.access_level(access).to_string()
    };
    let shared = Shared::spawned(
        Parts {
            dialect: Arc::new(dialect),
            events,
            project: project.clone(),
            access,
            catalog: catalog::empty_catalog(),
            instructions: None,
            roots: options.roots.clone(),
        },
        child,
    )?;
    let opened = {
        let _gate = startup_gate().lock().await;
        startup(&shared, &project, resume.clone(), options.replay_history, options.workbench_mcp.as_ref(), &options.roots, servers).await
    };
    if let Err(err) = opened {
        shared.shutdown();
        // 2026-11-10 agy 1.5.3：删掉 `conversations/<id>.db` 和 `brain/<id>` 后 `session/resume` 回
        // `Failed to read session <id>`。接不上又找不到文件，就是会话没了，不是这次没读成。
        if resume.as_deref().is_some_and(directory::is_gone) {
            return Err(AgentError::SessionGone);
        }
        return Err(err);
    }
    Ok(shared)
}

async fn startup(
    shared: &Shared,
    project: &Path,
    resume: Option<String>,
    replay_history: bool,
    mcp: Option<&WorkbenchMcp>,
    roots: &[String],
    servers: Value,
) -> Result<(), AgentError> {
    initialize(shared).await?;
    let moved = match resume.as_deref() {
        Some(id) => moved_from(shared, id, project).await,
        None => None,
    };
    let opening = match resume {
        Some(id) if replay_history => Opening::Load { id, replay: true },
        Some(id) => Opening::Resume { id },
        None => Opening::New,
    };
    // 追加的系统提示存进会话，以后接上时还在，再带一次就重复了。
    let instructions = match opening {
        Opening::New => mcp.map(WorkbenchMcp::instructions),
        _ => moved.map(|old| moved_note(&old, project)),
    };
    let params = thread_params(project, roots, servers, instructions);
    shared.open_thread(opening, params).await?;
    wait_for_commands(shared).await;
    shared.opened();
    Ok(())
}

/// 这条会话原来的目录和现在的不一样时返回原来的。
async fn moved_from(shared: &Shared, id: &str, project: &Path) -> Option<String> {
    let listed = read_list(shared).await.ok()?;
    let entry = listed.into_iter().find(|entry| entry.native_id == id)?;
    (entry.cwd_key != cwd_key(&project.to_string_lossy())).then_some(entry.cwd)
}

/// 换目录后旧目录还留在会话的工作区里，默认目录又按路径排序，命令可能还跑在旧目录
/// （2026-11-09 agy 1.5.3 实测），所以要明确告诉模型现在在哪。
fn moved_note(old: &str, project: &Path) -> String {
    format!(
        "This conversation has moved. The project directory is now {}. The earlier directory {old} is no longer the working copy: read, edit and run commands in the project directory, and set the working directory explicitly when you run commands.",
        project.display()
    )
}

/// 斜杠命令目录在打开的回包之后才推过来（实测约 100ms），等一下再告诉上层，作曲栏第一次取目录就有。
async fn wait_for_commands(shared: &Shared) {
    for _ in 0..COMMANDS_POLLS {
        if !shared.catalog.lock().unwrap().commands.is_empty() {
            return;
        }
        tokio::time::sleep(COMMANDS_POLL).await;
    }
}

async fn initialize(shared: &Shared) -> Result<(), AgentError> {
    shared
        .call(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                    // 声明 `form` 后 `ask_question` 走 `elicitation/create`，否则退回成聊天文字。
                    "elicitation": { "form": {} },
                },
                "clientInfo": { "name": "ai-workbench", "version": env!("CARGO_PKG_VERSION") },
            }),
            Some(HANDSHAKE),
        )
        .await
        .map(|_| ())
}

/// `session/new` / `load` / `resume` 共用的参数。
pub fn thread_params(project: &Path, roots: &[String], servers: Value, instructions: Option<String>) -> Value {
    let mut params = json!({ "cwd": with_drive_case(&project.to_string_lossy(), true), "mcpServers": servers });
    if !roots.is_empty() {
        let roots: Vec<String> = roots.iter().map(|root| with_drive_case(root, false)).collect();
        params["additionalDirectories"] = json!(roots);
    }
    if let Some(text) = instructions {
        params["_meta"] = json!({ "antigravity": { "systemPrompt": { "append": text } } });
    }
    params
}

/// agy 把工作区按字节排序，第一个当默认目录，额外目录排在项目前面时命令会跑到额外目录里。
/// 盘符不分大小写，项目写大写、额外目录写小写，项目就总在前面
/// （2026-11-09 agy 1.5.3：`C:\\p10` + `C:\\extra` 默认 `extra`，`C:\\p10` + `c:\\extra` 默认 `p10`）。
fn with_drive_case(path: &str, upper: bool) -> String {
    let mut chars = path.chars();
    match (chars.next(), chars.next()) {
        (Some(drive), Some(':')) if drive.is_ascii_alphabetic() => {
            let drive = if upper { drive.to_ascii_uppercase() } else { drive.to_ascii_lowercase() };
            format!("{drive}:{}", chars.as_str())
        }
        _ => path.to_string(),
    }
}

/// 起一个不开会话的进程，读 `session/list`。
pub async fn list_threads() -> Result<Vec<DirectoryEntry>, AgentError> {
    let program = process::resolve()?;
    let cwd = std::env::temp_dir();
    let child = process::spawn(&program, &cwd)?;
    let (events, _rx) = mpsc::unbounded_channel();
    let shared = Shared::spawned(
        Parts {
            dialect: Arc::new(AntigravityDialect::new(&cwd, events.clone(), false, json!([]))),
            events,
            project: cwd,
            access: "ask".into(),
            catalog: catalog::empty_catalog(),
            instructions: None,
            roots: Vec::new(),
        },
        child,
    )?;
    let listed = match initialize(&shared).await {
        Ok(()) => read_list(&shared).await,
        Err(err) => Err(err),
    };
    shared.shutdown_and_wait().await;
    listed
}

async fn read_list(shared: &Shared) -> Result<Vec<DirectoryEntry>, AgentError> {
    let mut entries = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = match &cursor {
            Some(cursor) => json!({ "cursor": cursor }),
            None => json!({}),
        };
        let page = shared.call("session/list", params, Some(HANDSHAKE)).await?;
        entries.extend(
            page.get("sessions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(entry),
        );
        cursor = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|next| !next.is_empty())
            .map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(entries)
}

/// `session/list` 的路径用正斜杠，工作台按项目目录比较时要和系统写法一致。
fn native_path(path: &str) -> String {
    if path.as_bytes().get(1) == Some(&b':') {
        path.replace('/', "\\")
    } else {
        path.to_string()
    }
}

fn entry(session: &Value) -> Option<DirectoryEntry> {
    let native_id = session.get("sessionId").and_then(Value::as_str)?.to_string();
    let cwd = native_path(&RULES.path(session.get("cwd").and_then(Value::as_str)?));
    let updated_at = session
        .get("updatedAt")
        .and_then(Value::as_str)
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .map(|at| at.timestamp_millis())
        .unwrap_or(0);
    Some(DirectoryEntry {
        native_id,
        cwd_key: cwd_key(&cwd),
        cwd,
        title: session.get("title").and_then(Value::as_str).unwrap_or("").trim().to_string(),
        created_at: updated_at,
        updated_at,
        status: SessionStatus::Completed,
        ephemeral: false,
        archived: false,
    })
}

#[cfg(test)]
pub(super) fn entry_for_test(session: &Value) -> Option<DirectoryEntry> {
    entry(session)
}

/// `Shared` 里的会话 id 对应的重新打开参数。
pub fn reopen(project: &Path, roots: &[String], servers: Value) -> Value {
    thread_params(project, roots, servers, None)
}
