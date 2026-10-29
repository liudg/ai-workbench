//! ACP 的 JSON-RPC 2.0：一行一个 JSON。宿主发请求用递增整数 id；
//! Agent 发来的请求（审批、提问、计划）按原 id 回包。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::AgentError;

/// ACP 错误码。`-32000` 是 `authRequired`（`@agentclientprotocol/sdk` `RequestError.authRequired`）。
pub const AUTH_REQUIRED: i64 = -32000;
pub const METHOD_NOT_FOUND: i64 = -32601;

#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    pub fn from_value(error: &Value) -> Self {
        let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
        let mut message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("未知错误")
            .to_string();
        if let Some(detail) = error
            .get("data")
            .and_then(|data| data.get("message").or(Some(data)))
            .and_then(Value::as_str)
            .filter(|detail| !detail.trim().is_empty() && !message.contains(*detail))
        {
            message = format!("{message}：{detail}");
        }
        Self { code, message }
    }
}

/// 一行收到的报文。
pub enum Incoming {
    Response { id: u64, result: Result<Value, RpcError> },
    Request { id: Value, method: String, params: Value },
    Notification { method: String, params: Value },
}

pub fn parse(line: &str) -> Option<Incoming> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    let method = value.get("method").and_then(Value::as_str);
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    match (method, value.get("id")) {
        (Some(method), Some(id)) if !id.is_null() => Some(Incoming::Request {
            id: id.clone(),
            method: method.to_string(),
            params,
        }),
        (Some(method), _) => Some(Incoming::Notification {
            method: method.to_string(),
            params,
        }),
        (None, Some(id)) => {
            let id = id.as_u64()?;
            let result = match value.get("error") {
                Some(error) if !error.is_null() => Err(RpcError::from_value(error)),
                _ => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
            };
            Some(Incoming::Response { id, result })
        }
        (None, None) => None,
    }
}

type Waiter = oneshot::Sender<Result<Value, RpcError>>;

pub struct Rpc {
    outbound: Mutex<Option<mpsc::UnboundedSender<String>>>,
    next: AtomicU64,
    waiters: Mutex<HashMap<u64, Waiter>>,
}

impl Rpc {
    pub fn new(outbound: mpsc::UnboundedSender<String>) -> Self {
        Self {
            outbound: Mutex::new(Some(outbound)),
            next: AtomicU64::new(1),
            waiters: Mutex::new(HashMap::new()),
        }
    }

    fn write(&self, message: Value) -> Result<(), AgentError> {
        let line = serde_json::to_string(&message).map_err(|err| AgentError::Runtime(err.to_string()))?;
        let outbound = self.outbound.lock().unwrap();
        let sender = outbound.as_ref().ok_or(AgentError::Closed)?;
        sender.send(line).map_err(|_| AgentError::Closed)
    }

    /// 发请求等回包。`timeout` 为 None 时一直等，`session/prompt` 要等整轮结束。
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Result<Value, RpcError>, AgentError> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.waiters.lock().unwrap().insert(id, tx);
        let sent = self.write(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }));
        if let Err(err) = sent {
            self.waiters.lock().unwrap().remove(&id);
            return Err(err);
        }
        let reply = match timeout {
            Some(limit) => match tokio::time::timeout(limit, rx).await {
                Ok(reply) => reply,
                Err(_) => {
                    self.waiters.lock().unwrap().remove(&id);
                    return Err(AgentError::Runtime(format!("Cursor Agent 没有回应 {method}")));
                }
            },
            None => rx.await,
        };
        reply.map_err(|_| AgentError::Closed)
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), AgentError> {
        self.write(json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    pub fn respond(&self, id: &Value, result: Value) -> Result<(), AgentError> {
        self.write(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }

    pub fn respond_error(&self, id: &Value, code: i64, message: &str) -> Result<(), AgentError> {
        self.write(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        }))
    }

    pub fn resolve(&self, id: u64, result: Result<Value, RpcError>) {
        if let Some(waiter) = self.waiters.lock().unwrap().remove(&id) {
            let _ = waiter.send(result);
        }
    }

    /// 进程退出：关掉写端，所有等待中的请求按关闭处理。
    pub fn close(&self) {
        self.outbound.lock().unwrap().take();
        self.waiters.lock().unwrap().clear();
    }
}
