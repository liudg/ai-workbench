//! 网页预览的本机后端入口（`cargo run --features dev-bridge --bin dev-bridge`）。
//!
//! 浏览器里没有 Tauri IPC。这里用 Tauri 的无窗口运行时装上和桌面版相同的命令表、
//! `ProjectStore` 与 `SessionManager`，把 `POST /invoke/<命令>` 交给真实命令处理，
//! 把 Tauri 事件转成 `GET /events` 的 SSE。Agent 会话、项目和目录都是真实的；
//! 需要原生窗口的内置浏览器命令不在这里注册，调用时返回命令不存在。
//! `browser_close` 例外：面板卸载总会调用它。没有子 webview 时只清主机状态。
//!
//! 只监听回环地址。数据目录用 `AI_WORKBENCH_DATA_DIR`，缺省与桌面版同一位置。

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Listener, WebviewWindowBuilder};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;

const CHANNELS: [&str; 5] = [
    "session-request",
    "session-event",
    "sessions-changed",
    "session-queue",
    "projects-changed",
];

const APP_IDENTIFIER: &str = "com.aiworkbench.app";

fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("AI_WORKBENCH_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("XDG_DATA_HOME"))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .unwrap_or_else(std::env::temp_dir);
    base.join(APP_IDENTIFIER)
}

type Webview = tauri::WebviewWindow<tauri::test::MockRuntime>;

pub fn run() {
    let addr = std::env::var("DEV_BRIDGE_ADDR").unwrap_or_else(|_| "127.0.0.1:4574".into());
    let data_dir = data_dir();
    let app = mock_builder()
        .invoke_handler(crate::workbench_handler![])
        .build(mock_context(noop_assets()))
        .expect("build dev bridge app");
    crate::manage_state(app.handle(), &data_dir).expect("load workbench state");
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("dev bridge webview");

    let (events, _) = broadcast::channel::<String>(4096);
    for channel in CHANNELS {
        let events = events.clone();
        app.listen_any(channel, move |event| {
            let payload = serde_json::from_str::<Value>(event.payload()).unwrap_or(Value::Null);
            let _ = events.send(json!({ "channel": channel, "payload": payload }).to_string());
        });
    }

    eprintln!(
        "ai-workbench dev bridge on http://{addr} (data: {})",
        data_dir.display()
    );
    tauri::async_runtime::block_on(async move {
        let listener = TcpListener::bind(&addr).await.expect("bind dev bridge");
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let webview = webview.clone();
            let events = events.subscribe();
            tauri::async_runtime::spawn(async move {
                let _ = serve(stream, webview, events).await;
            });
        }
    });
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}

async fn read_request(stream: &mut BufReader<TcpStream>) -> std::io::Result<Option<Request>> {
    let mut line = String::new();
    if stream.read_line(&mut line).await? == 0 {
        return Ok(None);
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        if stream.read_line(&mut header).await? == 0 {
            break;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0; length];
    stream.read_exact(&mut body).await?;
    Ok(Some(Request { method, path, body }))
}

async fn respond(stream: &mut BufReader<TcpStream>, status: &str, body: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let stream = stream.get_mut();
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.flush().await
}

async fn serve(
    stream: TcpStream,
    webview: Webview,
    mut events: broadcast::Receiver<String>,
) -> std::io::Result<()> {
    let mut stream = BufReader::new(stream);
    let Some(request) = read_request(&mut stream).await? else {
        return Ok(());
    };
    let path = request.path.trim_start_matches("/__bridge");
    if request.method == "GET" && path == "/events" {
        let socket = stream.get_mut();
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n: connected\n\n",
            )
            .await?;
        socket.flush().await?;
        loop {
            match events.recv().await {
                Ok(line) => {
                    socket.write_all(format!("data: {line}\n\n").as_bytes()).await?;
                    socket.flush().await?;
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return Ok(()),
            }
        }
    }
    let Some(cmd) = path.strip_prefix("/invoke/").filter(|_| request.method == "POST") else {
        return respond(&mut stream, "404 Not Found", "\"未知的 dev bridge 路径\"").await;
    };
    let args = if request.body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice::<Value>(&request.body) {
            Ok(value) => value,
            Err(err) => {
                let text = json!(format!("请求体不是 JSON：{err}")).to_string();
                return respond(&mut stream, "400 Bad Request", &text).await;
            }
        }
    };
    let invoke = InvokeRequest {
        cmd: cmd.to_string(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .expect("invoke url"),
        body: InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    let outcome = tokio::task::spawn_blocking(move || get_ipc_response(&webview, invoke))
        .await
        .map_err(|err| std::io::Error::other(err.to_string()))?;
    match outcome {
        Ok(InvokeResponseBody::Json(text)) => respond(&mut stream, "200 OK", &text).await,
        Ok(InvokeResponseBody::Raw(bytes)) => {
            let text = json!(String::from_utf8_lossy(&bytes)).to_string();
            respond(&mut stream, "200 OK", &text).await
        }
        Err(err) => respond(&mut stream, "500 Internal Server Error", &err.to_string()).await,
    }
}
