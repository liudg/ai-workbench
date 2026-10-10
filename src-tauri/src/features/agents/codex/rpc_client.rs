//! 给设置页用的常驻 app-server。会话线程仍用自己的进程。

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

use crate::encoding::{apply_utf8_env, decode_child_bytes};
use crate::features::agents::AgentError;

use super::process::{apply_codex_network_env, hide_console, resolve_codex_bin};

#[derive(Clone)]
pub(super) struct HostRpc {
    out: mpsc::UnboundedSender<String>,
    child: Arc<Mutex<Option<Child>>>,
    next_id: Arc<AtomicU64>,
    waiters: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
}

fn slot() -> &'static tokio::sync::Mutex<Option<HostRpc>> {
    static SLOT: OnceLock<tokio::sync::Mutex<Option<HostRpc>>> = OnceLock::new();
    SLOT.get_or_init(|| tokio::sync::Mutex::new(None))
}

pub(super) async fn codex_call(
    method: &str,
    params: Value,
    budget: Duration,
) -> Result<Value, AgentError> {
    let client = ensure().await?;
    match client.request(method, params.clone(), budget).await {
        Ok(value) => Ok(value),
        Err(_) => {
            reset().await;
            let client = ensure().await?;
            client.request(method, params, budget).await
        }
    }
}

async fn ensure() -> Result<HostRpc, AgentError> {
    let mut guard = slot().lock().await;
    if guard.is_none() {
        *guard = Some(HostRpc::spawn().await?);
    }
    Ok(guard.as_ref().unwrap().clone())
}

async fn reset() {
    let mut guard = slot().lock().await;
    if let Some(client) = guard.take() {
        if let Some(child) = client.child.lock().unwrap().as_mut() {
            let _ = child.start_kill();
        }
    }
}

impl HostRpc {
    async fn spawn() -> Result<Self, AgentError> {
        let bin = resolve_codex_bin()?;
        let mut command = Command::new(bin);
        command
            .arg("app-server")
            .env_remove("TERM")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        apply_codex_network_env(&mut command);
        apply_utf8_env(&mut command);
        hide_console(&mut command);
        let mut child = command
            .spawn()
            .map_err(|err| AgentError::Runtime(format!("无法启动 Codex CLI：{err}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AgentError::Runtime("Codex CLI 没有标准输入".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AgentError::Runtime("Codex CLI 没有标准输出".into()))?;
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(line) = out_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                    || stdin.flush().await.is_err()
                {
                    break;
                }
            }
        });
        let waiters: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let reader_waiters = Arc::clone(&waiters);
        let reply = out_tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout);
            let mut raw = Vec::new();
            loop {
                raw.clear();
                let Ok(n) = lines.read_until(b'\n', &mut raw).await else {
                    break;
                };
                if n == 0 {
                    break;
                }
                if raw.last() == Some(&b'\n') {
                    raw.pop();
                }
                if raw.last() == Some(&b'\r') {
                    raw.pop();
                }
                let line = decode_child_bytes(&raw);
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    if message.get("method").is_some() {
                        answer_server_request(&reply, id, &message);
                        continue;
                    }
                    if let Some(waiter) = reader_waiters.lock().unwrap().remove(&id) {
                        let _ = waiter.send(message);
                    }
                }
            }
        });
        let client = Self {
            out: out_tx,
            child: Arc::new(Mutex::new(Some(child))),
            next_id: Arc::new(AtomicU64::new(1)),
            waiters,
        };
        client
            .request(
                "initialize",
                json!({
                    "clientInfo": { "name": "ai-workbench", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "experimentalApi": true }
                }),
                Duration::from_secs(30),
            )
            .await?;
        client.notify("initialized", json!({}));
        Ok(client)
    }

    fn notify(&self, method: &str, params: Value) {
        let line = json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string();
        let _ = self.out.send(line);
    }

    async fn request(&self, method: &str, params: Value, budget: Duration) -> Result<Value, AgentError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.waiters.lock().unwrap().insert(id, tx);
        let line = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        })
        .to_string();
        if self.out.send(line).is_err() {
            self.waiters.lock().unwrap().remove(&id);
            return Err(AgentError::Runtime("无法向 Codex CLI 写入消息".into()));
        }
        match timeout(budget, rx).await {
            Ok(Ok(message)) => {
                if let Some(err) = message.get("error") {
                    Err(AgentError::Runtime(
                        err.get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Codex 返回错误")
                            .to_string(),
                    ))
                } else {
                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                }
            }
            _ => {
                self.waiters.lock().unwrap().remove(&id);
                Err(AgentError::Runtime(format!("等待 Codex {method} 超时")))
            }
        }
    }
}

fn answer_server_request(out: &mpsc::UnboundedSender<String>, id: u64, message: &Value) {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    if method == "currentTime/read" {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let line = json!({ "jsonrpc": "2.0", "id": id, "result": { "currentTimeAt": now } }).to_string();
        let _ = out.send(line);
        return;
    }
    let line = json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": -32601, "message": "ai-workbench 设置进程不处理该请求" }
    })
    .to_string();
    let _ = out.send(line);
}
