//! 子线程的思考和正文按线程、条目分别累积，输出完整快照供时间线原位更新。

use std::collections::HashMap;

use aiwb_core::models::{MessagePhase, SessionEventBody};
use serde_json::Value;

use super::history::reasoning_text;

#[derive(Default)]
struct Stream {
    text: String,
    summary: String,
    phase: Option<MessagePhase>,
}

impl Stream {
    fn body(&self, id: &str, thinking: bool) -> Option<SessionEventBody> {
        let text = if thinking && !self.summary.trim().is_empty() { &self.summary } else { &self.text };
        if thinking {
            Some(SessionEventBody::Thinking {
                text: if text.trim().is_empty() { "思考中…".into() } else { text.clone() },
                stream_id: Some(id.to_string()),
            })
        } else {
            (!text.trim().is_empty()).then(|| SessionEventBody::AgentMessage {
                text: text.clone(),
                stream_id: Some(id.to_string()),
                phase: self.phase,
                mode: None,
                dedupe_of: None,
            })
        }
    }
}

#[derive(Default)]
pub(super) struct SubagentStreams {
    threads: HashMap<String, HashMap<String, Stream>>,
}

impl SubagentStreams {
    pub(super) fn item(&mut self, thread: &str, item: &Value, completed: bool) -> Option<SessionEventBody> {
        let id = item.get("id")?.as_str()?;
        let thinking = item.get("type")?.as_str()? == "reasoning";
        let streams = self.threads.entry(thread.to_string()).or_default();
        let stream = streams.entry(id.to_string()).or_default();
        let text = if thinking {
            reasoning_text(item)
        } else {
            item.get("text").and_then(Value::as_str).unwrap_or("").to_string()
        };
        if !text.trim().is_empty() {
            stream.text = text;
            stream.summary.clear();
        }
        if let Some(phase) = MessagePhase::parse(item.get("phase").and_then(Value::as_str)) {
            stream.phase = Some(phase);
        }
        let body = stream.body(id, thinking);
        if completed {
            streams.remove(id);
        }
        body
    }

    pub(super) fn delta(&mut self, thread: &str, method: &str, params: &Value) -> Option<SessionEventBody> {
        let id = params.get("itemId")?.as_str()?;
        let delta = params.get("delta")?.as_str()?;
        if delta.is_empty() {
            return None;
        }
        let stream = self.threads.entry(thread.to_string()).or_default().entry(id.to_string()).or_default();
        let thinking = method != "item/agentMessage/delta";
        if method == "item/reasoning/summaryTextDelta" {
            stream.summary.push_str(delta);
        } else {
            stream.text.push_str(delta);
        }
        stream.body(id, thinking)
    }

    pub(super) fn finish(&mut self, thread: &str) {
        self.threads.remove(thread);
    }

    pub(super) fn clear(&mut self) {
        self.threads.clear();
    }
}
