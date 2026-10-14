//! Claude Code 会话 token。
//!
//! 工作台用 `--input-format stream-json`。官方用量说明
//! （https://code.claude.com/docs/en/agent-sdk/cost-tracking）：
//! - 同一步的多条 assistant 消息共用 `message.id`，usage 相同，按 id 只计一次。
//! - assistant 上的 `output_tokens` 是占位，不计入。
//! - 流式输入时，每条 `result.usage` 只覆盖这一回合的主循环（不含子代理）。
//!   各回合相加。不要再把同一回合的 assistant usage 加进去。
//! - `result.modelUsage` / `total_cost_usd` 是整次调用的累计（恢复会话时含此前花费），
//!   并且带价格。这里不读这些字段。
//!
//! 重新打开时扫本会话 jsonl（`~/.claude/projects/*.jsonl`）。
//! 主循环的输入和缓存来自去重后的 assistant；输出只来自文件里的 `result`
//! （jsonl 通常没有 result，没有就不编输出）。子代理消息用各自的 `message.id`。

use std::collections::HashMap;

use serde_json::Value;

use crate::models::SessionEventBody;

#[derive(Clone, Copy, Default)]
struct Parts {
    input: Option<i64>,
    output: Option<i64>,
    cache_read: Option<i64>,
    cache_write: Option<i64>,
}

impl Parts {
    fn is_empty(self) -> bool {
        self.input.is_none() && self.output.is_none() && self.cache_read.is_none() && self.cache_write.is_none()
    }

    fn add(&mut self, other: Self) {
        add_field(&mut self.input, other.input);
        add_field(&mut self.output, other.output);
        add_field(&mut self.cache_read, other.cache_read);
        add_field(&mut self.cache_write, other.cache_write);
    }
}

fn add_field(slot: &mut Option<i64>, value: Option<i64>) {
    let Some(value) = value else {
        return;
    };
    *slot = Some(slot.unwrap_or(0).saturating_add(value.max(0)));
}

/// 历史 jsonl → 一条快照。没有 usage 就不发。
pub(super) fn snapshot_from_transcript(content: &str) -> Option<SessionEventBody> {
    let mut assistants: HashMap<String, Parts> = HashMap::new();
    let mut results: HashMap<String, Parts> = HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if flag(&value, "isMeta") {
            continue;
        }
        match value.get("type").and_then(Value::as_str).unwrap_or("") {
            "assistant" => {
                let Some(id) = message_id(&value) else {
                    continue;
                };
                let Some(mut parts) = parts_from_usage(value.get("message").and_then(|message| message.get("usage"))) else {
                    continue;
                };
                parts.output = None;
                assistants.insert(id, parts);
            }
            "result" => {
                let Some(parts) = parts_from_usage(value.get("usage")) else {
                    continue;
                };
                results.insert(result_key(&value), parts);
            }
            _ => {}
        }
    }
    let mut total = Parts::default();
    if assistants.is_empty() {
        for parts in results.values() {
            total.add(*parts);
        }
    } else {
        for parts in assistants.values() {
            total.add(*parts);
        }
        for parts in results.values() {
            add_field(&mut total.output, parts.output);
        }
    }
    usage_event("snapshot", None, total)
}

/// 实时 `result`。调用方只在 live 流上用它，历史快照另算。
pub(super) fn live_result(value: &Value) -> Option<SessionEventBody> {
    let parts = parts_from_usage(value.get("usage"))?;
    usage_event("delta", Some(result_key(value)), parts)
}

/// 子代理的 assistant。主循环的输入已经在 `result.usage` 里，这里不再计。
/// `output_tokens` 仍是占位，丢掉。
pub(super) fn live_subagent(value: &Value) -> Option<SessionEventBody> {
    if !is_subagent(value) {
        return None;
    }
    let id = message_id(value)?;
    let mut parts = parts_from_usage(value.get("message").and_then(|message| message.get("usage")))?;
    parts.output = None;
    usage_event("delta", Some(format!("assistant:{id}")), parts)
}

fn usage_event(scope: &str, key: Option<String>, parts: Parts) -> Option<SessionEventBody> {
    if parts.is_empty() {
        return None;
    }
    Some(SessionEventBody::SessionUsage {
        scope: scope.into(),
        key,
        input_tokens: parts.input,
        output_tokens: parts.output,
        cache_read_tokens: parts.cache_read,
        cache_write_tokens: parts.cache_write,
    })
}

fn is_subagent(value: &Value) -> bool {
    flag(value, "isSidechain")
        || value
            .get("parent_tool_use_id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
}

fn message_id(value: &Value) -> Option<String> {
    value
        .get("message")
        .and_then(|message| message.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .or_else(|| {
            value
                .get("uuid")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
        })
}

fn result_key(value: &Value) -> String {
    if let Some(uuid) = value.get("uuid").and_then(Value::as_str).filter(|id| !id.is_empty()) {
        return format!("result:{uuid}");
    }
    if let Some(turn) = value.get("num_turns").and_then(as_i64) {
        return format!("result:turn:{turn}");
    }
    let usage = value.get("usage").cloned().unwrap_or(Value::Null);
    format!("result:usage:{}", usage)
}

fn parts_from_usage(usage: Option<&Value>) -> Option<Parts> {
    let usage = usage?;
    let parts = Parts {
        input: field(usage, "input_tokens"),
        output: field(usage, "output_tokens"),
        cache_read: field(usage, "cache_read_input_tokens"),
        cache_write: cache_write(usage),
    };
    (!parts.is_empty()).then_some(parts)
}

fn cache_write(usage: &Value) -> Option<i64> {
    if let Some(number) = field(usage, "cache_creation_input_tokens") {
        return Some(number);
    }
    let object = usage.get("cache_creation")?.as_object()?;
    let mut sum = 0_i64;
    let mut saw = false;
    for (key, value) in object {
        if key.ends_with("_input_tokens") {
            if let Some(number) = as_i64(value) {
                sum = sum.saturating_add(number.max(0));
                saw = true;
            }
        }
    }
    saw.then_some(sum)
}

fn field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(as_i64)
}

fn as_i64(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    if let Some(number) = value.as_u64() {
        return i64::try_from(number).ok();
    }
    value.as_f64().map(|number| number as i64)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn usage_of(body: Option<SessionEventBody>) -> (String, Option<String>, Parts) {
        match body {
            Some(SessionEventBody::SessionUsage {
                scope,
                key,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
            }) => (
                scope,
                key,
                Parts {
                    input: input_tokens,
                    output: output_tokens,
                    cache_read: cache_read_tokens,
                    cache_write: cache_write_tokens,
                },
            ),
            other => panic!("expected session usage, got {other:?}"),
        }
    }

    #[test]
    fn transcript_dedupes_message_id_and_ignores_assistant_output() {
        let text = r#"
{"type":"assistant","uuid":"u1","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":4,"cache_creation_input_tokens":2}}}
{"type":"assistant","uuid":"u2","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":99,"cache_read_input_tokens":4,"cache_creation_input_tokens":2}}}
{"type":"assistant","uuid":"u3","isSidechain":true,"message":{"id":"msg_2","usage":{"input_tokens":3,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
{"type":"assistant","uuid":"u4","isMeta":true,"message":{"id":"msg_meta","usage":{"input_tokens":1000,"output_tokens":1}}}
{"type":"result","uuid":"r1","usage":{"input_tokens":99,"output_tokens":40,"cache_read_input_tokens":99,"cache_creation_input_tokens":9}}
{"type":"result","uuid":"r1","usage":{"input_tokens":99,"output_tokens":40,"cache_read_input_tokens":99}}
{"type":"result","uuid":"r2","usage":{"output_tokens":7}}
"#;
        let (scope, key, parts) = usage_of(snapshot_from_transcript(text));
        assert_eq!(scope, "snapshot");
        assert!(key.is_none());
        assert_eq!(parts.input, Some(13));
        assert_eq!(parts.cache_read, Some(4));
        assert_eq!(parts.cache_write, Some(2));
        assert_eq!(parts.output, Some(47));
    }

    #[test]
    fn transcript_without_assistant_rows_uses_result_usage() {
        let text = r#"{"type":"result","num_turns":1,"usage":{"input_tokens":5,"output_tokens":6,"cache_read_input_tokens":1,"cache_creation":{"ephemeral_5m_input_tokens":2,"ephemeral_1h_input_tokens":3}}}"#;
        let (_, _, parts) = usage_of(snapshot_from_transcript(text));
        assert_eq!(parts.input, Some(5));
        assert_eq!(parts.output, Some(6));
        assert_eq!(parts.cache_read, Some(1));
        assert_eq!(parts.cache_write, Some(5));
    }

    #[test]
    fn empty_transcript_reports_nothing() {
        assert!(snapshot_from_transcript("").is_none());
        assert!(snapshot_from_transcript(r#"{"type":"assistant","message":{"id":"m","content":[]}}"#).is_none());
    }

    #[test]
    fn live_result_is_one_delta_and_subagent_drops_placeholder_output() {
        let result = json!({
            "type": "result",
            "uuid": "r-live",
            "usage": {"input_tokens": 3, "output_tokens": 4, "cache_read_input_tokens": 1, "cache_creation_input_tokens": 2},
            "total_cost_usd": 1.25,
            "modelUsage": {"claude": {"inputTokens": 100, "outputTokens": 100, "costUSD": 9}}
        });
        let (scope, key, parts) = usage_of(live_result(&result));
        assert_eq!(scope, "delta");
        assert_eq!(key.as_deref(), Some("result:r-live"));
        assert_eq!(parts.input, Some(3));
        assert_eq!(parts.output, Some(4));
        assert_eq!(parts.cache_read, Some(1));
        assert_eq!(parts.cache_write, Some(2));

        let main = json!({
            "type": "assistant",
            "uuid": "a",
            "message": {"id": "msg_main", "usage": {"input_tokens": 8, "output_tokens": 1}}
        });
        assert!(live_subagent(&main).is_none());

        let side = json!({
            "type": "assistant",
            "uuid": "b",
            "isSidechain": true,
            "message": {"id": "msg_side", "usage": {"input_tokens": 8, "output_tokens": 1, "cache_read_input_tokens": 2}}
        });
        let (scope, key, parts) = usage_of(live_subagent(&side));
        assert_eq!(scope, "delta");
        assert_eq!(key.as_deref(), Some("assistant:msg_side"));
        assert_eq!(parts.input, Some(8));
        assert_eq!(parts.output, None);
        assert_eq!(parts.cache_read, Some(2));
    }
}
