//! 一条 WebSocket 连接：收请求、回响应、转发已订阅主题的推送。
//!
//! `subscribe` / `unsubscribe` 在读循环里同步处理，保证快照先于后续推送进入发送队列。
//! 终端输入也在读循环里写，按键不会乱序。其余方法各开一个任务，慢请求不挡后面的消息。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use aiwb_core::rpc::{Push, Request, Response, TOPIC_TERMINAL_PREFIX};
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{broadcast, mpsc};

use crate::services::Services;

/// 主题 → 订阅时的推送序号。只转发比它新的推送。
type Subscriptions = Arc<Mutex<HashMap<String, u64>>>;

/// 连接编号。daemon 按连接记谁在看哪个任务，连接断了就不算在看。
static NEXT_CONNECTION: AtomicU64 = AtomicU64::new(1);

#[derive(Deserialize)]
struct TopicParams {
    topic: String,
}

#[derive(Deserialize)]
struct TerminalInput {
    id: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewParams {
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SideTabsParams {
    session_ids: Vec<String>,
}

/// 订阅参数里除 `topic` 以外的部分（会话主题的 `fromRev`）。
fn snapshot_params(params: &Value) -> Value {
    let mut rest = params.clone();
    if let Some(map) = rest.as_object_mut() {
        map.remove("topic");
    }
    rest
}

pub(crate) async fn serve(socket: WebSocket, services: Arc<Services>) {
    let (mut sink, mut stream) = socket.split();
    let (out, mut outbox) = mpsc::unbounded_channel::<String>();
    let subs: Subscriptions = Arc::default();
    let connection = NEXT_CONNECTION.fetch_add(1, Ordering::Relaxed);

    let writer = tokio::spawn(async move {
        while let Some(text) = outbox.recv().await {
            if sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let forwarder = tokio::spawn(forward(services.clone(), subs.clone(), out.clone()));

    loop {
        let message = tokio::select! {
            message = stream.next() => message,
            _ = services.shutdown_requested() => break,
        };
        let text = match message {
            Some(Ok(Message::Text(text))) => text,
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
            Some(Ok(_)) => continue,
        };
        let request: Request = match serde_json::from_str(&text) {
            Ok(request) => request,
            Err(err) => {
                eprintln!("收到无法解析的消息：{err}");
                continue;
            }
        };
        match request.method.as_str() {
            "subscribe" => {
                let response = subscribe(&services, &subs, &out, connection, request.id, request.params);
                send(&out, &response);
            }
            "unsubscribe" => {
                let response = match parse_topic(request.params) {
                    Ok(topic) => {
                        subs.lock().unwrap().remove(&topic);
                        Response::ok(request.id, Value::Null)
                    }
                    Err(err) => Response::err(request.id, err),
                };
                send(&out, &response);
            }
            "terminals.write" => {
                let response = match serde_json::from_value::<TerminalInput>(request.params) {
                    Ok(input) => match services.terminals.write(&input.id, &input.data) {
                        Ok(()) => Response::ok(request.id, Value::Null),
                        Err(err) => Response::err(request.id, err),
                    },
                    Err(err) => Response::err(request.id, format!("参数不对：{err}")),
                };
                send(&out, &response);
            }
            // 要知道是哪条连接，不走 dispatch。
            "attention.view" => {
                let response = match serde_json::from_value::<ViewParams>(request.params) {
                    Ok(params) => match services.runtimes.set_viewing(connection, params.task_id) {
                        Ok(()) => Response::ok(request.id, Value::Null),
                        Err(err) => Response::err(request.id, err),
                    },
                    Err(err) => Response::err(request.id, format!("参数不对：{err}")),
                };
                send(&out, &response);
            }
            // 同上，记在这条连接名下，断开时清掉。
            "tasks.sideTabs" => {
                let response = match serde_json::from_value::<SideTabsParams>(request.params) {
                    Ok(params) => {
                        services.runtimes.set_side_tabs(connection, params.session_ids);
                        Response::ok(request.id, Value::Null)
                    }
                    Err(err) => Response::err(request.id, format!("参数不对：{err}")),
                };
                send(&out, &response);
            }
            _ => {
                let services = services.clone();
                let out = out.clone();
                tokio::spawn(async move {
                    let response = match services.dispatch(&request.method, request.params).await {
                        Ok(result) => Response::ok(request.id, result),
                        Err(err) => Response::err(request.id, err),
                    };
                    send(&out, &response);
                });
            }
        }
    }

    forwarder.abort();
    let _ = services.runtimes.set_viewing(connection, None);
    services.runtimes.set_side_tabs(connection, Vec::new());
    services.terminals.forget(connection);
    drop(out);
    let _ = writer.await;
}

fn parse_topic(params: Value) -> Result<String, String> {
    serde_json::from_value::<TopicParams>(params)
        .map(|p| p.topic)
        .map_err(|e| format!("参数不对：{e}"))
}

fn subscribe(
    services: &Services,
    subs: &Subscriptions,
    out: &mpsc::UnboundedSender<String>,
    connection: u64,
    id: u64,
    params: Value,
) -> Response {
    let extra = snapshot_params(&params);
    let topic = match parse_topic(params) {
        Ok(topic) => topic,
        Err(err) => return Response::err(id, err),
    };
    if let Some(terminal_id) = topic.strip_prefix(TOPIC_TERMINAL_PREFIX) {
        services.terminals.watch(terminal_id, connection);
    }
    let result = services.hub().snapshot_with(
        || services.snapshot(&topic, &extra),
        |seq, data| {
            subs.lock().unwrap().insert(topic.clone(), seq);
            send(out, &Push { topic: topic.clone(), data });
        },
    );
    match result {
        Ok(()) => Response::ok(id, Value::Null),
        Err(err) => Response::err(id, err),
    }
}

async fn forward(services: Arc<Services>, subs: Subscriptions, out: mpsc::UnboundedSender<String>) {
    let mut rx = services.hub().receiver();
    loop {
        match rx.recv().await {
            Ok(envelope) => {
                let wanted = subs
                    .lock()
                    .unwrap()
                    .get(&envelope.topic)
                    .is_some_and(|since| envelope.seq > *since);
                if wanted {
                    send(
                        &out,
                        &Push {
                            topic: envelope.topic.clone(),
                            data: envelope.data.clone(),
                        },
                    );
                }
            }
            // 落后太多丢了推送：每个已订阅主题重发一次完整快照（会话主题带 reset）。
            Err(broadcast::error::RecvError::Lagged(_)) => {
                let topics: Vec<String> = subs.lock().unwrap().keys().cloned().collect();
                for topic in topics {
                    let _ = services.hub().snapshot_with(
                        || services.snapshot(&topic, &Value::Null),
                        |seq, data| {
                            subs.lock().unwrap().insert(topic.clone(), seq);
                            send(&out, &Push { topic: topic.clone(), data });
                        },
                    );
                }
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

fn send<T: serde::Serialize>(out: &mpsc::UnboundedSender<String>, value: &T) {
    let text = serde_json::to_string(value).expect("serialize message");
    let _ = out.send(text);
}
