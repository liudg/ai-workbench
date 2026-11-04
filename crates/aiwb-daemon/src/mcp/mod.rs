//! 工作台自己的 MCP 服务，只给工作台拉起的 Agent 会话用。挂在 `/mcp`，和 `/ws` 共用回环端口。
//!
//! - 凭证：每次拉起 Agent 进程时给这个会话发一个（[`Credentials`]），适配器把地址和凭证注入 Agent。
//! - 认人：中间件按 `Authorization` 认出调用方会话，放进请求扩展；工具参数里写 [`Caller`] 就取到它，
//!   取不到（凭证作废、调用方不在回合里）时工具不会被调用。作用范围都按这个会话来定。
//! - 协议：官方 Rust SDK `rmcp` 的 Streamable HTTP，无状态，每个请求单独处理，daemon 重启不用恢复 MCP 会话。
//! - 工具：按功能分组，每组一个文件、一个 `ToolRouter`，在 [`server`] 里相加。业务逻辑在 `services` 里，
//!   这里只做参数、调用方和结果的转换。
//!
//! 照 t3code `apps/server/src/mcp/McpHttpServer.ts`、`McpSessionRegistry.ts`。

mod server;
mod subtasks;
mod tokens;

use std::sync::Arc;

use aiwb_core::models::SessionStatus;
use aiwb_core::task::Task;
use axum::extract::{Request, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::Router;
use rmcp::handler::server::common::FromContextPart;
use rmcp::handler::server::tool::ToolCallContext;
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};

use crate::services::{Caller, Services};

pub(crate) use tokens::Credentials;

/// 哪些会话拿到工作台 MCP。现在只有子任务工具：项目里的顶层任务。子任务不能再开子任务，独立聊天没有项目。
pub(crate) fn serves(task: &Task) -> bool {
    task.project_id.is_some() && task.parent_task_id.is_none()
}

pub(crate) fn router(services: Arc<Services>) -> Router<Arc<Services>> {
    let server = server::WorkbenchServer::new(services.clone());
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_sse_keep_alive(None);
    let service = StreamableHttpService::new(
        move || Ok(server.clone()),
        Arc::new(NeverSessionManager::default()),
        config,
    );
    Router::new()
        .route_service("/mcp", service)
        .route_layer(middleware::from_fn_with_state(services, authorize))
}

/// 认出来的调用方会话 id。
#[derive(Clone)]
struct CallerSession(String);

async fn authorize(State(services): State<Arc<Services>>, mut request: Request, next: Next) -> Response {
    let session = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .and_then(|token| services.runtimes.mcp.resolve(token));
    let Some(session) = session else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    request.extensions_mut().insert(CallerSession(session));
    next.run(request).await
}

impl FromContextPart<ToolCallContext<'_, server::WorkbenchServer>> for Caller {
    fn from_context_part(context: &mut ToolCallContext<'_, server::WorkbenchServer>) -> Result<Self, rmcp::ErrorData> {
        let session = context
            .request_context
            .extensions
            .get::<Parts>()
            .and_then(|parts| parts.extensions.get::<CallerSession>())
            .map(|CallerSession(id)| id.clone());
        caller(&context.service.services, session.as_deref())
            .map_err(|message| rmcp::ErrorData::invalid_request(message, None))
    }
}

/// 调用方必须正处在一个回合里：进程退了、回合结束后，留下的凭证不能再动东西（照 t3code `assertLiveCaller`）。
fn caller(services: &Services, session_id: Option<&str>) -> Result<Caller, String> {
    let session_id = session_id.ok_or_else(|| "unauthorized: 没有认出调用方".to_string())?;
    let session = services
        .store
        .session(session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "unauthorized: 会话不存在".to_string())?;
    if session.status != SessionStatus::Running || !services.runtimes.is_live(&session.id) {
        return Err("parent_not_active: 调用方会话不在回合里".into());
    }
    let task = services
        .store
        .task(&session.task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "unauthorized: 任务不存在".to_string())?;
    Ok(Caller { session, task })
}
