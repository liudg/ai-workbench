//! `thread/queue/*`。排队卡片不进时间线；消失且不是用户删除时，补一条用户气泡。

use std::collections::HashSet;

use serde_json::{json, Value};

use crate::features::agents::AgentError;
use crate::models::{PageAnnotation, QueuedTurn, SessionEventBody};

use super::catalog::build_turn_input;
use super::resume::{image_from_part, user_item_images, user_item_text};
use super::state::{emit, Shared};

pub(super) const QUEUE_GONE: &str = "这条排队消息已经不在队列里";

impl Shared {
    pub(super) fn poke_queue(&self) {
        let _ = self.queue_notify.send(());
    }

    pub(super) async fn refresh_queue(&self) {
        let _guard = self.queue_refresh.lock().await;
        let Some(thread_id) = self.thread_id.lock().unwrap().clone() else {
            return;
        };
        let mut items = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..5 {
            let mut params = json!({ "threadId": thread_id, "limit": 50 });
            if let Some(cursor) = &cursor {
                params["cursor"] = json!(cursor);
            }
            match self.request("thread/queue/list", params).await {
                Ok(page) => {
                    if let Some(data) = page.get("data").and_then(Value::as_array) {
                        for value in data {
                            if let Some(turn) = queued_from_submission(value) {
                                items.push(turn);
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
                Err(err) => {
                    if queue_unsupported(&err) {
                        self.publish_queue(Vec::new());
                    }
                    return;
                }
            }
        }
        self.publish_queue(items);
    }

    pub(super) async fn enqueue(
        &self,
        text: String,
        images: Vec<String>,
        client_id: String,
        annotations: Vec<PageAnnotation>,
    ) -> Result<(), AgentError> {
        self.ensure_thread().await?;
        let thread_id = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Runtime("Codex 线程未建立".into()))?;
        let input = {
            let skills = self.skills.lock().unwrap();
            build_turn_input(&text, &skills, &images, &annotations)
        };
        let result = self
            .request(
                "thread/queue/add",
                json!({
                    "threadId": thread_id,
                    "input": input,
                    "clientUserMessageId": client_id,
                }),
            )
            .await?;
        let submission = result.get("queuedSubmission").unwrap_or(&result);
        let mut turn = queued_from_submission(submission)
            .ok_or_else(|| AgentError::Runtime("Codex 没有返回排队消息".into()))?;
        turn.text = text;
        turn.images = images;
        if turn.client_id.is_empty() {
            turn.client_id = client_id;
        }
        self.queued.lock().unwrap().push(turn);
        self.refresh_queue().await;
        Ok(())
    }

    pub(super) async fn update_queued(
        &self,
        id: &str,
        text: String,
        images: Vec<String>,
        annotations: Vec<PageAnnotation>,
    ) -> Result<(), AgentError> {
        let thread_id = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Runtime("Codex 线程未建立".into()))?;
        let input = {
            let skills = self.skills.lock().unwrap();
            build_turn_input(&text, &skills, &images, &annotations)
        };
        let result = self
            .request(
                "thread/queue/update",
                json!({
                    "threadId": thread_id,
                    "queuedSubmissionId": id,
                    "input": input,
                }),
            )
            .await
            .map_err(map_missing)?;
        if result.get("queuedSubmission").is_none() && result.get("id").is_none() {
            return Err(AgentError::Runtime(QUEUE_GONE.into()));
        }
        {
            let mut queued = self.queued.lock().unwrap();
            let Some(item) = queued.iter_mut().find(|item| item.id == id) else {
                return Err(AgentError::Runtime(QUEUE_GONE.into()));
            };
            item.text = text;
            item.images = images;
        }
        self.refresh_queue().await;
        Ok(())
    }

    pub(super) async fn remove_queued(&self, id: &str) -> Result<(), AgentError> {
        let thread_id = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Runtime("Codex 线程未建立".into()))?;
        self.queue_removed.lock().unwrap().insert(id.to_string());
        let result = self
            .request(
                "thread/queue/delete",
                json!({
                    "threadId": thread_id,
                    "queuedSubmissionId": id,
                }),
            )
            .await;
        match result {
            Ok(value) => {
                if !value.get("deleted").and_then(Value::as_bool).unwrap_or(true) {
                    self.queue_removed.lock().unwrap().remove(id);
                    self.refresh_queue().await;
                    return Err(AgentError::Runtime(QUEUE_GONE.into()));
                }
            }
            Err(err) => {
                self.queue_removed.lock().unwrap().remove(id);
                self.refresh_queue().await;
                return Err(map_missing(err));
            }
        }
        self.refresh_queue().await;
        Ok(())
    }

    /// 只认仍在队列里、且带 clientId 的 userMessage。直接发送和斜杠回显没有这个 id。
    pub(super) fn note_user_item(&self, item: &Value) {
        let client_id = item
            .get("clientId")
            .or_else(|| item.get("clientUserMessageId"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if client_id.is_empty() || self.shown_users.lock().unwrap().contains(&client_id) {
            return;
        }
        let turn = self
            .queued
            .lock()
            .unwrap()
            .iter()
            .find(|turn| turn.client_id == client_id)
            .cloned();
        let Some(turn) = turn else {
            return;
        };
        self.shown_users.lock().unwrap().insert(client_id);
        let text = if turn.text.is_empty() {
            user_item_text(item)
        } else {
            turn.text
        };
        let images = if turn.images.is_empty() {
            user_item_images(item)
        } else {
            turn.images
        };
        if text.is_empty() && images.is_empty() {
            return;
        }
        emit(
            &self.events,
            SessionEventBody::UserMessage { text, images, annotations: 0 },
        );
    }

    fn publish_queue(&self, incoming: Vec<QueuedTurn>) {
        let previous = self.queued.lock().unwrap().clone();
        let removed = self.queue_removed.lock().unwrap().clone();
        let shown = self.shown_users.lock().unwrap().clone();
        let (merged, dispatched) = diff_queue(&previous, incoming, &removed, &shown);
        *self.queued.lock().unwrap() = merged.clone();
        self.queue_removed
            .lock()
            .unwrap()
            .retain(|id| merged.iter().any(|item| &item.id == id));
        {
            let mut shown = self.shown_users.lock().unwrap();
            for item in &dispatched {
                if !item.client_id.is_empty() {
                    shown.insert(item.client_id.clone());
                }
                emit(
                    &self.events,
                    SessionEventBody::UserMessage {
                        text: item.text.clone(),
                        images: item.images.clone(),
                        annotations: 0,
                    },
                );
            }
        }
        emit(
            &self.events,
            SessionEventBody::QueueChanged { items: merged },
        );
    }
}

pub(super) fn queued_from_submission(value: &Value) -> Option<QueuedTurn> {
    let id = value.get("id").and_then(Value::as_str)?.to_string();
    if id.is_empty() {
        return None;
    }
    let parts = value
        .get("input")
        .or_else(|| value.get("content"))
        .and_then(Value::as_array);
    let (text, images) = match parts {
        Some(parts) => collect_parts(parts),
        None => (String::new(), Vec::new()),
    };
    let client_id = value
        .get("clientUserMessageId")
        .or_else(|| value.get("clientId"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Some(QueuedTurn {
        id,
        text,
        images,
        client_id,
    })
}

fn collect_parts(parts: &[Value]) -> (String, Vec<String>) {
    let mut text = Vec::new();
    let mut images = Vec::new();
    for part in parts {
        let kind = part.get("type").and_then(Value::as_str).unwrap_or("text");
        if kind == "text" || kind == "input_text" {
            if let Some(piece) = part.get("text").and_then(Value::as_str) {
                if !piece.is_empty() {
                    text.push(piece.to_string());
                }
            }
            continue;
        }
        if let Some(image) = image_from_part(part) {
            images.push(image);
        }
    }
    (text.join("\n"), images)
}

/// 保留客户端原文和路径。从列表消失、且不是用户删掉的，视为已发出。
pub(super) fn diff_queue(
    previous: &[QueuedTurn],
    incoming: Vec<QueuedTurn>,
    removed: &HashSet<String>,
    shown: &HashSet<String>,
) -> (Vec<QueuedTurn>, Vec<QueuedTurn>) {
    let merged = incoming
        .into_iter()
        .map(|mut item| {
            if let Some(prev) = previous.iter().find(|prev| prev.id == item.id) {
                item.text = prev.text.clone();
                item.images = prev.images.clone();
                if item.client_id.is_empty() {
                    item.client_id = prev.client_id.clone();
                }
            }
            item
        })
        .collect::<Vec<_>>();
    let dispatched = previous
        .iter()
        .filter(|prev| {
            if merged.iter().any(|item| item.id == prev.id) {
                return false;
            }
            if removed.contains(&prev.id) {
                return false;
            }
            !prev.client_id.is_empty() && !shown.contains(&prev.client_id)
        })
        .cloned()
        .collect();
    (merged, dispatched)
}

fn queue_unsupported(err: &AgentError) -> bool {
    let msg = err.to_string().to_ascii_lowercase();
    msg.contains("ephemeral")
        || msg.contains("does not support")
        || msg.contains("method not found")
        || msg.contains("unknown method")
}

fn map_missing(err: AgentError) -> AgentError {
    let msg = err.to_string().to_ascii_lowercase();
    if msg.contains("no longer") || msg.contains("not found") || msg.contains("missing field") {
        AgentError::Runtime(QUEUE_GONE.into())
    } else {
        err
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(id: &str, text: &str) -> QueuedTurn {
        QueuedTurn {
            id: id.into(),
            text: text.into(),
            images: vec!["C:/shot.png".into()],
            client_id: format!("c-{id}"),
        }
    }

    #[test]
    fn parses_queue_submission_and_keeps_client_copy_on_refresh() {
        let parsed = queued_from_submission(&json!({
            "id": "q1",
            "clientUserMessageId": "c-q1",
            "input": [
                { "type": "text", "text": "服务端快照" },
                { "type": "image", "url": "data:image/png;base64,aaaa" }
            ]
        }))
        .unwrap();
        assert_eq!(parsed.text, "服务端快照");
        assert_eq!(parsed.images, vec!["data:image/png;base64,aaaa"]);
        let previous = vec![turn("q1", "原文")];
        let (merged, dispatched) =
            diff_queue(&previous, vec![parsed], &HashSet::new(), &HashSet::new());
        assert!(dispatched.is_empty());
        assert_eq!(merged[0].text, "原文");
        assert_eq!(merged[0].images, vec!["C:/shot.png"]);
    }

    #[test]
    fn vanish_without_delete_dispatches_once() {
        let previous = vec![turn("q1", "稍后")];
        let (merged, dispatched) =
            diff_queue(&previous, Vec::new(), &HashSet::new(), &HashSet::new());
        assert!(merged.is_empty());
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].text, "稍后");

        let mut removed = HashSet::new();
        removed.insert("q1".into());
        let (_, deleted) = diff_queue(&previous, Vec::new(), &removed, &HashSet::new());
        assert!(deleted.is_empty());
    }
}
