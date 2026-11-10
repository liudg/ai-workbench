//! 拉起 `agent acp` 并打开一条会话。
//!
//! 启动顺序：`initialize` → `cursor/list_available_models` → `session/new` 或 `session/load`。
//! 冷启动要联网取模型目录，本进程里排队握手。取不到时怎么重试见 [`super::retry`]。
//! 只探模型目录（不 `persist`、不 resume）时不建会话，免得在 `~/.cursor/acp-sessions` 留下空会话。

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use serde_json::{json, Value};

use super::catalog;
use super::dialect::CursorDialect;
use super::directory;
use super::process::{self, Launcher};
use super::retry::{self, Miss};
use crate::acp::rpc::{self, RpcError};
use crate::acp::runtime::{mcp_servers, Opening, Parts, Shared, HANDSHAKE};
use crate::{AgentError, EventSink, WorkbenchMcp};

/// 同一时刻只让一个 `agent acp` 走初始化。
fn startup_gate() -> &'static tokio::sync::Mutex<()> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub fn services_unavailable(err: &RpcError) -> bool {
    err.code == rpc::INTERNAL_ERROR && err.message.contains("Failed to initialize ACP services")
}

pub struct Open {
    pub project_path: String,
    pub access_mode: Option<String>,
    pub resume: Option<String>,
    pub persist: bool,
    pub replay_history: bool,
    pub workbench_mcp: Option<WorkbenchMcp>,
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
    let launcher = process::resolve()?;
    let shared = retry::with_restarts(|| launch(&launcher, &project, &options, &events)).await?;
    let mcp_servers = mcp_servers(options.workbench_mcp.as_ref());
    let opened = startup(&shared, &project, resume, options.persist, options.replay_history, mcp_servers).await;
    if let Err(err) = opened {
        shared.shutdown();
        return Err(err);
    }
    Ok(shared)
}

/// 起一个 `agent acp`，握手并取到模型目录。没取到就关掉这个进程。
async fn launch(
    launcher: &Launcher,
    project: &Path,
    options: &Open,
    events: &EventSink,
) -> Result<Arc<Shared>, Miss> {
    let child = process::spawn(launcher, project)?;
    let access = match options.access_mode.as_deref().unwrap_or("full") {
        "full" => "full",
        _ => "ask",
    };
    let shared = Shared::spawned(
        Parts {
            dialect: Arc::new(CursorDialect::new(project)),
            events: events.clone(),
            project: project.to_path_buf(),
            access: access.to_string(),
            catalog: catalog::empty_catalog(),
            instructions: options.workbench_mcp.as_ref().map(WorkbenchMcp::instructions),
            roots: Vec::new(),
        },
        child,
    )?;
    let models = {
        let _gate = startup_gate().lock().await;
        handshake(&shared).await
    };
    match models {
        Ok(models) => {
            catalog::apply_model_list(&mut shared.catalog.lock().unwrap(), &models);
            Ok(shared)
        }
        Err(miss) => {
            shared.shutdown_and_wait().await;
            Err(miss)
        }
    }
}

async fn handshake(shared: &Shared) -> Result<Value, Miss> {
    shared
        .call(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                    "_meta": { "parameterizedModelPicker": true, "subagents": true },
                },
                "clientInfo": { "name": "ai-workbench", "version": env!("CARGO_PKG_VERSION") },
            }),
            Some(HANDSHAKE),
        )
        .await?;
    retry::refetch(|| fetch_models(shared)).await
}

async fn fetch_models(shared: &Shared) -> Result<Value, Miss> {
    const METHOD: &str = "cursor/list_available_models";
    let reply = tokio::time::timeout(HANDSHAKE, shared.rpc.request(METHOD, json!({}), None));
    let Ok(result) = reply.await else {
        return Err(Miss::Stalled);
    };
    if let Ok(Err(err)) = &result {
        if services_unavailable(err) {
            return Err(Miss::Services(err.message.clone()));
        }
    }
    let models = shared.settle(METHOD, result)?;
    if catalog::has_models(&models) {
        Ok(models)
    } else {
        Err(Miss::Empty)
    }
}

async fn startup(
    shared: &Shared,
    project: &Path,
    resume: Option<String>,
    persist: bool,
    replay_history: bool,
    mcp_servers: Value,
) -> Result<(), AgentError> {
    let params = json!({ "cwd": project.to_string_lossy(), "mcpServers": mcp_servers });
    // 没发过消息的会话只有 meta.json，`session/load` 认不出来。里面没有历史，换一个新会话。
    let placeholder = resume.as_deref().filter(|id| directory::is_placeholder(id)).map(str::to_string);
    let resume = if placeholder.is_some() { None } else { resume };
    let persist = persist || placeholder.is_some();
    if let Some(id) = resume {
        shared.open_thread(Opening::Load { id, replay: replay_history }, params).await?;
    } else if persist {
        shared.open_thread(Opening::New, params).await?;
        if let Some(old) = placeholder {
            let _ = directory::remove(&old);
        }
    }
    shared.opened();
    Ok(())
}
