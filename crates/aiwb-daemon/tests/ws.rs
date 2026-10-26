//! 真实起一个 HTTP 服务，用 WebSocket 客户端走一遍：鉴权、调用、订阅快照和变更推送。

use std::sync::Arc;
use std::time::Duration;

use aiwb_core::DaemonInfo;
use aiwb_daemon::{router, Services};
use aiwb_store::Store;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn start() -> (u16, Arc<Services>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let info = DaemonInfo {
        version: "test".into(),
        build: "b1".into(),
        pid: 1,
        port,
        token: "secret".into(),
    };
    let services = Arc::new(Services::new(
        Arc::new(Store::open_in_memory().unwrap()),
        info,
        std::env::temp_dir(),
    ));
    let app = router(services.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (port, services)
}

async fn connect(port: u16) -> Socket {
    let url = format!("ws://127.0.0.1:{port}/ws?token=secret");
    tokio_tungstenite::connect_async(url).await.unwrap().0
}

async fn send(socket: &mut Socket, value: Value) {
    socket.send(Message::Text(value.to_string())).await.unwrap();
}

async fn next(socket: &mut Socket) -> Value {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("等消息超时")
            .unwrap()
            .unwrap();
        if let Message::Text(text) = message {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

#[tokio::test]
async fn rejects_wrong_token() {
    let (port, _) = start().await;
    let url = format!("ws://127.0.0.1:{port}/ws?token=nope");
    assert!(tokio_tungstenite::connect_async(url).await.is_err());
}

#[tokio::test]
async fn subscribe_gets_snapshot_then_changes() {
    let (port, _) = start().await;
    let mut watcher = connect(port).await;
    let mut actor = connect(port).await;

    send(&mut watcher, json!({ "id": 1, "method": "subscribe", "params": { "topic": "projects" } })).await;
    assert_eq!(next(&mut watcher).await, json!({ "topic": "projects", "data": [] }));
    assert_eq!(next(&mut watcher).await, json!({ "id": 1, "result": null }));

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_string_lossy().to_string();
    send(&mut actor, json!({ "id": 7, "method": "projects.add", "params": { "path": path } })).await;
    let added = next(&mut actor).await;
    assert_eq!(added["id"], 7);
    let project_id = added["result"]["id"].clone();

    let pushed = next(&mut watcher).await;
    assert_eq!(pushed["topic"], "projects");
    assert_eq!(pushed["data"][0]["id"], project_id);

    send(&mut actor, json!({ "id": 8, "method": "projects.list" })).await;
    let listed = next(&mut actor).await;
    assert_eq!(listed["result"].as_array().unwrap().len(), 1);

    send(&mut actor, json!({ "id": 9, "method": "nope" })).await;
    let failed = next(&mut actor).await;
    assert_eq!(failed["id"], 9);
    assert!(failed["error"]["message"].as_str().unwrap().contains("nope"));
}

#[tokio::test]
async fn shutdown_needs_token() {
    let (port, services) = start().await;
    let status = http_post(port, "/shutdown", None).await;
    assert!(status.starts_with("HTTP/1.1 401"));
    let status = http_post(port, "/shutdown", Some("secret")).await;
    assert!(status.starts_with("HTTP/1.1 204"));
    tokio::time::timeout(Duration::from_secs(1), services.shutdown_requested())
        .await
        .expect("shutdown 没有生效");
}

async fn http_post(port: u16, path: &str, token: Option<&str>) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let auth = token
        .map(|t| format!("authorization: Bearer {t}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "POST {path} HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: 0\r\n{auth}connection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    response
}
