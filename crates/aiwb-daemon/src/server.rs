//! HTTP 入口：`/ws` 给客户端，`/health` 和 `/shutdown` 给应用壳管理进程。

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;

use crate::connection;
use crate::services::Services;

pub fn router(services: Arc<Services>) -> Router {
    Router::new()
        .route("/ws", get(ws))
        .route("/health", get(health))
        .route("/shutdown", post(shutdown))
        .with_state(services)
}

async fn ws(
    State(services): State<Arc<Services>>,
    Query(query): Query<HashMap<String, String>>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if query.get("token").map(String::as_str) != Some(services.info().token.as_str()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    upgrade.on_upgrade(move |socket| connection::serve(socket, services))
}

/// 不带 token：版本供应用壳判断要不要换 daemon；`running` 是还在跑或在等输入的会话数，退出前确认用。
async fn health(State(services): State<Arc<Services>>) -> impl IntoResponse {
    let info = services.info();
    Json(json!({
        "version": info.version,
        "build": info.build,
        "pid": info.pid,
        "running": services.running_sessions(),
        "upgrading": services.running_upgrades(),
    }))
}

async fn shutdown(State(services): State<Arc<Services>>, headers: HeaderMap) -> StatusCode {
    let expected = format!("Bearer {}", services.info().token);
    let authorized = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == expected);
    if !authorized {
        return StatusCode::UNAUTHORIZED;
    }
    services.request_shutdown();
    StatusCode::NO_CONTENT
}
