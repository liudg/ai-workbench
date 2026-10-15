//! 会话目录用的短命 app-server 客户端。只服务 `thread/list` 和目录上的 RPC。

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

use crate::encoding::{apply_utf8_env, decode_child_bytes};

use crate::features::agents::directory::DirectoryEntry;

use super::process::{apply_codex_network_env, cli_version, hide_console, resolve_codex_bin};
use super::resume::parse_thread;

const PAGE_LIMIT: u32 = 100;
const MAX_PAGES: usize = 40;

pub(super) struct RpcClient {
    out: mpsc::UnboundedSender<String>,
    child: Mutex<Option<Child>>,
    next_id: AtomicU64,
    waiters: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
}

impl RpcClient {
    pub(super) async fn spawn() -> Result<Self, String> {
        let bin = resolve_codex_bin().map_err(|err| err.to_string())?;
        let cli_version = cli_version(&bin).await;
        let mut command = Command::new(&bin);
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
            .map_err(|err| format!("无法启动 Codex CLI：{err}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Codex CLI 没有标准输入".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex CLI 没有标准输出".to_string())?;
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
            child: Mutex::new(Some(child)),
            next_id: AtomicU64::new(1),
            waiters,
        };
        client
            .request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": super::CODEX_CLIENT_NAME,
                        "version": super::client_info_version(cli_version.as_deref()),
                    },
                    "capabilities": { "experimentalApi": true }
                }),
                Duration::from_secs(30),
            )
            .await?;
        client.notify("initialized", json!({}));
        Ok(client)
    }

    pub(super) async fn list_pages(&self, archived: bool) -> Result<Vec<DirectoryEntry>, String> {
        let mut cursor: Option<String> = None;
        let mut threads = Vec::new();
        for _ in 0..MAX_PAGES {
            let mut params = json!({
                "archived": archived,
                "limit": PAGE_LIMIT,
                "sortKey": "updated_at",
                "sortDirection": "desc",
            });
            if let Some(cursor) = &cursor {
                params["cursor"] = json!(cursor);
            }
            let page = self
                .request("thread/list", params, Duration::from_secs(60))
                .await?;
            let data = page
                .get("data")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for item in &data {
                if let Some(thread) = parse_thread(item) {
                    if !thread.ephemeral {
                        threads.push(thread);
                    }
                }
            }
            cursor = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|cursor| !cursor.is_empty())
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(threads)
    }

    fn notify(&self, method: &str, params: Value) {
        let line = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        })
        .to_string();
        let _ = self.out.send(line);
    }

    pub(super) async fn request(
        &self,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, String> {
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
            return Err("无法向 Codex CLI 写入消息".into());
        }
        match timeout(budget, rx).await {
            Ok(Ok(message)) => {
                if let Some(err) = message.get("error") {
                    Err(err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex 返回错误")
                        .to_string())
                } else {
                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                }
            }
            _ => {
                self.waiters.lock().unwrap().remove(&id);
                Err(format!("等待 Codex {method} 超时"))
            }
        }
    }
}

impl RpcClient {
    /// 关掉标准输入并等进程退出，释放线程写锁。超时再强制结束。
    pub(super) async fn shutdown(self) {
        let child = self.child.lock().unwrap().take();
        drop(self);
        let Some(mut child) = child else {
            return;
        };
        if timeout(Duration::from_secs(2), child.wait()).await.is_err() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }
}

impl Drop for RpcClient {
    fn drop(&mut self) {
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.start_kill();
        }
    }
}

fn answer_server_request(out: &mpsc::UnboundedSender<String>, id: u64, message: &Value) {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let result = if method == "currentTime/read" {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        json!({ "currentTimeAt": now })
    } else {
        let line = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": "ai-workbench 目录进程不处理该请求" }
        })
        .to_string();
        let _ = out.send(line);
        return;
    };
    let line = json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string();
    let _ = out.send(line);
}


