//! Claude Code 会话 token。实时 stdout 和重开 jsonl 用同一条规则：
//! 每个 `message.id` 是一次 API 调用，不跨调用累计；同一次调用里流式 usage 是累计值，只留最后一条。
//!
//! 泄漏源码 `services/api/claude.ts`：
//! - `updateUsage`（L2914–2946）：一次响应里的 usage 是累计值，不是增量。
//!   `input_tokens` / `cache_*` 在 `message_start` 定下来；`message_delta` 里的 0 不覆盖。
//!   `output_tokens`（L2946）用最新一次的数。每次开流先 `usage = EMPTY_USAGE`（L1864）。
//! - `content_block_stop`（L2171–2210）按内容块各产出一条 assistant，此时 `output_tokens`
//!   还是 `message_start` 的占位。`message_delta`（L2213–2247）把最终 usage 写回最后一条。
//! - `accumulateUsage`（L2989–3004）把各次 API 调用相加。`QueryEngine.ts` 在每次
//!   `message_start` 把 `currentMessageUsage` 清零（L789–795），`message_stop` 再累加进
//!   `totalUsage`（L810–815）。`result.usage` 就是这个 `totalUsage`（L1146）。
//!   再加 assistant 会把同一次调用算两次。
//!
//! jsonl 懒写入会带上这次改写（`QueryEngine.ts` L718–728，`sessionStorage.ts` L567 的 100ms）。
//! stdout 在 `content_block_stop` 就序列化（`cli/print.ts` L884–885，`cli/structuredIO.ts` `write` L465–466），
//! 最终 output 在随后的 `stream_event` / `message_delta`。工作台开了 `--include-partial-messages`。
//!
//! 不读 `total_cost_usd` / `modelUsage`。没有 assistant 记录时才用 `result.usage`。

use std::collections::HashMap;

use serde_json::Value;

use aiwb_core::models::SessionEventBody;

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
struct Parts {
    input: Option<i64>,
    output: Option<i64>,
    cache_read: Option<i64>,
    cache_write: Option<i64>,
}

impl Parts {
    fn is_empty(self) -> bool {
        self.input.is_none()
            && self.output.is_none()
            && self.cache_read.is_none()
            && self.cache_write.is_none()
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

/// 一次 API 调用进行中的用量。`message_delta` 之后不再用占位 assistant 盖掉。
#[derive(Default)]
pub(super) struct LiveCursor {
    id: String,
    parts: Parts,
    finalized: bool,
}

/// 每个 message id 一份用量。后来的同一 id 替换，不累加。
/// 发出的是这些 id 的绝对合计，所以实时流和结束后的 jsonl 不会把同一次调用算两遍。
#[derive(Default)]
pub(super) struct UsageLedger {
    messages: HashMap<String, Parts>,
}

impl UsageLedger {
    pub(super) fn seed_transcript(&mut self, content: &str) {
        self.messages = message_parts_from_transcript(content);
    }

    /// 用文件里的最终用量覆盖同一 id。文件里还没有的实时调用留着。
    /// 有 assistant 记录时不再保留只来自 `result.usage` 的合计。
    pub(super) fn merge_transcript(&mut self, content: &str) {
        let incoming = message_parts_from_transcript(content);
        let incoming_calls = incoming.keys().any(|key| !key.starts_with("result:"));
        if incoming_calls {
            self.messages.retain(|key, _| !key.starts_with("result:"));
            for (id, parts) in incoming {
                self.messages.insert(id, parts);
            }
            return;
        }
        if self.messages.keys().any(|key| !key.starts_with("result:")) {
            return;
        }
        self.messages = incoming;
    }

    /// 实时增量按 message id 替换，并返回替换后的会话合计快照。
    pub(super) fn absorb_delta(&mut self, event: &SessionEventBody) -> Option<SessionEventBody> {
        let SessionEventBody::SessionUsage {
            scope,
            key,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
        } = event
        else {
            return None;
        };
        if scope != "delta" {
            return None;
        }
        let Some(raw) = key.as_deref().map(str::trim).filter(|item| !item.is_empty()) else {
            return None;
        };
        let id = raw.strip_prefix("assistant:").unwrap_or(raw);
        let parts = Parts {
            input: *input_tokens,
            output: *output_tokens,
            cache_read: *cache_read_tokens,
            cache_write: *cache_write_tokens,
        };
        if parts.is_empty() {
            return None;
        }
        self.messages.retain(|key, _| !key.starts_with("result:"));
        self.messages.insert(id.to_string(), parts);
        self.snapshot()
    }

    pub(super) fn snapshot(&self) -> Option<SessionEventBody> {
        let mut total = Parts::default();
        for parts in self.messages.values() {
            total.add(*parts);
        }
        usage_event("snapshot", None, total)
    }
}

/// 历史 jsonl → 一条快照。同一 `message.id` 只留文件里的最后一条。
/// 有 assistant 记录就不加 `result`。没有 assistant 时才用 `result.usage`。
pub(super) fn snapshot_from_transcript(content: &str) -> Option<SessionEventBody> {
    let mut ledger = UsageLedger::default();
    ledger.seed_transcript(content);
    ledger.snapshot()
}

fn message_parts_from_transcript(content: &str) -> HashMap<String, Parts> {
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
                let Some(parts) = assistant_parts(&value) else {
                    continue;
                };
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
    if assistants.is_empty() {
        results
    } else {
        assistants
    }
}

/// `stream_event` 里的 `message_start` / `message_delta`。
pub(super) fn apply_stream(cursor: &mut LiveCursor, event: &Value) -> Option<SessionEventBody> {
    match event.get("type").and_then(Value::as_str).unwrap_or("") {
        "message_start" => {
            let id = event
                .get("message")
                .and_then(|message| message.get("id"))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())?;
            let parts = parts_from_usage(
                event
                    .get("message")
                    .and_then(|message| message.get("usage")),
            )?;
            cursor.id = id.to_string();
            cursor.parts = parts;
            cursor.finalized = false;
            usage_event("delta", Some(format!("assistant:{id}")), cursor.parts)
        }
        "message_delta" => {
            if cursor.id.is_empty() {
                return None;
            }
            let usage = event.get("usage")?;
            merge_stream_delta(&mut cursor.parts, usage);
            if cursor.parts.is_empty() {
                return None;
            }
            cursor.finalized = true;
            usage_event(
                "delta",
                Some(format!("assistant:{}", cursor.id)),
                cursor.parts,
            )
        }
        _ => None,
    }
}

/// 一条 assistant。同一 id 在 `message_delta` 之后不再用占位 output 覆盖。
pub(super) fn apply_assistant(cursor: &mut LiveCursor, value: &Value) -> Option<SessionEventBody> {
    let id = message_id(value)?;
    let parts = assistant_parts(value)?;
    if cursor.finalized && cursor.id == id {
        return None;
    }
    cursor.id = id.clone();
    cursor.parts = parts;
    cursor.finalized = false;
    usage_event("delta", Some(format!("assistant:{id}")), cursor.parts)
}

fn assistant_parts(value: &Value) -> Option<Parts> {
    parts_from_usage(
        value
            .get("message")
            .and_then(|message| message.get("usage")),
    )
}

/// 对齐 `updateUsage`：输入和缓存只在大于 0 时覆盖，output 用本次给出的累计值。
fn merge_stream_delta(parts: &mut Parts, usage: &Value) {
    if let Some(number) = field(usage, "input_tokens").filter(|number| *number > 0) {
        parts.input = Some(number);
    }
    if let Some(number) = field(usage, "cache_read_input_tokens").filter(|number| *number > 0) {
        parts.cache_read = Some(number);
    }
    if let Some(number) = cache_write(usage).filter(|number| *number > 0) {
        parts.cache_write = Some(number);
    }
    if let Some(number) = field(usage, "output_tokens") {
        parts.output = Some(number.max(0));
    }
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
    if let Some(uuid) = value
        .get("uuid")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
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
    fn transcript_keeps_the_last_record_per_message_id() {
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
        assert_eq!(parts.output, Some(100));
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
        assert!(snapshot_from_transcript(
            r#"{"type":"assistant","message":{"id":"m","content":[]}}"#
        )
        .is_none());
    }

    #[test]
    fn message_delta_finalizes_output_and_a_later_chunk_cannot_downgrade_it() {
        let mut cursor = LiveCursor::default();
        let start = json!({
            "type": "message_start",
            "message": {
                "id": "msg_main",
                "usage": {"input_tokens": 8, "output_tokens": 1, "cache_read_input_tokens": 2, "cache_creation_input_tokens": 4}
            }
        });
        let (_, key, parts) = usage_of(apply_stream(&mut cursor, &start));
        assert_eq!(key.as_deref(), Some("assistant:msg_main"));
        assert_eq!(parts.output, Some(1));

        let chunk = json!({
            "type": "assistant",
            "uuid": "a",
            "message": {"id": "msg_main", "usage": {"input_tokens": 8, "output_tokens": 1, "cache_read_input_tokens": 2, "cache_creation_input_tokens": 4}}
        });
        let (_, _, parts) = usage_of(apply_assistant(&mut cursor, &chunk));
        assert_eq!(parts.output, Some(1));

        let delta = json!({
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn"},
            "usage": {"input_tokens": 0, "output_tokens": 40, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        });
        let (scope, key, parts) = usage_of(apply_stream(&mut cursor, &delta));
        assert_eq!(scope, "delta");
        assert_eq!(key.as_deref(), Some("assistant:msg_main"));
        assert_eq!(parts.input, Some(8));
        assert_eq!(parts.output, Some(40));
        assert_eq!(parts.cache_read, Some(2));
        assert_eq!(parts.cache_write, Some(4));

        let late = json!({
            "type": "assistant",
            "uuid": "b",
            "message": {"id": "msg_main", "usage": {"input_tokens": 8, "output_tokens": 1}}
        });
        assert!(apply_assistant(&mut cursor, &late).is_none());

        let side = json!({
            "type": "assistant",
            "uuid": "c",
            "isSidechain": true,
            "message": {"id": "msg_side", "usage": {"input_tokens": 8, "output_tokens": 6, "cache_read_input_tokens": 2}}
        });
        let (_, key, parts) = usage_of(apply_assistant(&mut cursor, &side));
        assert_eq!(key.as_deref(), Some("assistant:msg_side"));
        assert_eq!(parts.output, Some(6));
    }

    #[test]
    fn recorded_jsonl_without_result_matches_the_live_stream() {
        let (_, _, resumed) = usage_of(snapshot_from_transcript(RECORDED_CLAUDE_JSONL));
        assert_eq!(
            resumed,
            Parts {
                input: Some(15),
                output: Some(126),
                cache_read: Some(17_400),
                cache_write: Some(1_200),
            }
        );

        let mut cursor = LiveCursor::default();
        let mut events = Vec::new();
        for line in RECORDED_CLAUDE_LIVE.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let value: serde_json::Value = serde_json::from_str(line).unwrap();
            let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
            let body = match kind {
                "stream_event" => {
                    apply_stream(&mut cursor, value.get("event").unwrap_or(&Value::Null))
                }
                "assistant" => apply_assistant(&mut cursor, &value),
                "result" => None,
                _ => None,
            };
            if let Some(body) = body {
                events.push(body);
            }
        }
        assert_eq!(fold_deltas(&events), resumed);
    }

    #[test]
    fn ledger_replaces_a_message_instead_of_adding_it_twice() {
        let mut ledger = UsageLedger::default();
        ledger.seed_transcript(
            r#"{"type":"assistant","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":1}}}"#,
        );
        let first = usage_event(
            "delta",
            Some("assistant:msg_1".into()),
            Parts {
                input: Some(10),
                output: Some(5),
                cache_read: None,
                cache_write: None,
            },
        )
        .expect("delta");
        let (_, _, parts) = usage_of(ledger.absorb_delta(&first));
        assert_eq!(parts.input, Some(10));
        assert_eq!(parts.output, Some(5));

        let extra = usage_event(
            "delta",
            Some("assistant:msg_2".into()),
            Parts {
                input: Some(3),
                output: Some(1),
                cache_read: None,
                cache_write: None,
            },
        )
        .expect("delta");
        let (_, _, parts) = usage_of(ledger.absorb_delta(&extra));
        assert_eq!(parts.input, Some(13));
        assert_eq!(parts.output, Some(6));

        ledger.merge_transcript(
            r#"{"type":"assistant","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":9}}}"#,
        );
        let (_, _, parts) = usage_of(ledger.snapshot());
        assert_eq!(parts.input, Some(13));
        assert_eq!(parts.output, Some(10));
    }

    fn fold_deltas(events: &[SessionEventBody]) -> Parts {
        let mut deltas = std::collections::HashMap::<String, Parts>::new();
        for event in events {
            let (_, key, parts) = usage_of(Some(event.clone()));
            deltas.insert(key.expect("delta key"), parts);
        }
        let mut total = Parts::default();
        for parts in deltas.values() {
            total.add(*parts);
        }
        total
    }
}

/// 形状对齐 `~/.claude/projects/*.jsonl`。同一 `message.id` 有多块，最后一块才是改写后的完整 usage。没有 `result`。
#[cfg(test)]
pub(super) const RECORDED_CLAUDE_JSONL: &str = r#"
{"parentUuid":null,"isSidechain":false,"type":"user","uuid":"11111111-1111-4111-8111-111111111111","timestamp":"2026-04-21T02:14:01.100Z","sessionId":"6b9c0e2a-4f31-4a77-9c2e-0a1b2c3d4e5f","cwd":"/workspace/app","version":"2.1.88","message":{"role":"user","content":[{"type":"text","text":"列出 src 里的测试"}]}}
{"parentUuid":"11111111-1111-4111-8111-111111111111","isSidechain":false,"type":"assistant","uuid":"22222222-2222-4222-8222-222222222221","timestamp":"2026-04-21T02:14:03.100Z","sessionId":"6b9c0e2a-4f31-4a77-9c2e-0a1b2c3d4e5f","cwd":"/workspace/app","version":"2.1.88","requestId":"req_01A","message":{"model":"claude-sonnet-4-5","id":"msg_01ABC","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"先看目录"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"cache_creation_input_tokens":1200,"cache_read_input_tokens":8000,"output_tokens":1,"cache_creation":{"ephemeral_5m_input_tokens":1200,"ephemeral_1h_input_tokens":0},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0}}}}
{"parentUuid":"22222222-2222-4222-8222-222222222221","isSidechain":false,"type":"assistant","uuid":"22222222-2222-4222-8222-222222222222","timestamp":"2026-04-21T02:14:03.400Z","sessionId":"6b9c0e2a-4f31-4a77-9c2e-0a1b2c3d4e5f","cwd":"/workspace/app","version":"2.1.88","requestId":"req_01A","message":{"model":"claude-sonnet-4-5","id":"msg_01ABC","type":"message","role":"assistant","content":[{"type":"text","text":"我先列一下。"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"cache_creation_input_tokens":1200,"cache_read_input_tokens":8000,"output_tokens":2,"cache_creation":{"ephemeral_5m_input_tokens":1200,"ephemeral_1h_input_tokens":0},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0}}}}
{"parentUuid":"22222222-2222-4222-8222-222222222222","isSidechain":false,"type":"assistant","uuid":"22222222-2222-4222-8222-222222222223","timestamp":"2026-04-21T02:14:03.800Z","sessionId":"6b9c0e2a-4f31-4a77-9c2e-0a1b2c3d4e5f","cwd":"/workspace/app","version":"2.1.88","requestId":"req_01A","message":{"model":"claude-sonnet-4-5","id":"msg_01ABC","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Bash","input":{"command":"ls src"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":3,"cache_creation_input_tokens":1200,"cache_read_input_tokens":8000,"output_tokens":86,"cache_creation":{"ephemeral_5m_input_tokens":1200,"ephemeral_1h_input_tokens":0},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0}}}}
{"parentUuid":"22222222-2222-4222-8222-222222222223","isSidechain":false,"type":"user","uuid":"33333333-3333-4333-8333-333333333333","timestamp":"2026-04-21T02:14:04.200Z","sessionId":"6b9c0e2a-4f31-4a77-9c2e-0a1b2c3d4e5f","cwd":"/workspace/app","version":"2.1.88","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"a.rs\nb.rs"}]}}
{"parentUuid":"33333333-3333-4333-8333-333333333333","isSidechain":false,"type":"assistant","uuid":"44444444-4444-4444-8444-444444444441","timestamp":"2026-04-21T02:14:06.100Z","sessionId":"6b9c0e2a-4f31-4a77-9c2e-0a1b2c3d4e5f","cwd":"/workspace/app","version":"2.1.88","requestId":"req_01B","message":{"model":"claude-sonnet-4-5","id":"msg_02DEF","type":"message","role":"assistant","content":[{"type":"text","text":"目录里有"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":12,"cache_creation_input_tokens":0,"cache_read_input_tokens":9400,"output_tokens":1,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0}}}}
{"parentUuid":"44444444-4444-4444-8444-444444444441","isSidechain":false,"type":"assistant","uuid":"44444444-4444-4444-8444-444444444442","timestamp":"2026-04-21T02:14:06.500Z","sessionId":"6b9c0e2a-4f31-4a77-9c2e-0a1b2c3d4e5f","cwd":"/workspace/app","version":"2.1.88","requestId":"req_01B","message":{"model":"claude-sonnet-4-5","id":"msg_02DEF","type":"message","role":"assistant","content":[{"type":"text","text":" a.rs 和 b.rs。"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":12,"cache_creation_input_tokens":0,"cache_read_input_tokens":9400,"output_tokens":40,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0}}}}
"#;

/// 同一会话的 stdout。assistant 在 `content_block_stop` 写出，output 仍是占位；完整 output 在后面的 `message_delta`。
/// 末尾多一条同 id 的占位 assistant，以及一条更大的 `result`，两者都不能改总数。
#[cfg(test)]
pub(super) const RECORDED_CLAUDE_LIVE: &str = r#"
{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_01ABC","type":"message","role":"assistant","model":"claude-sonnet-4-5","usage":{"input_tokens":3,"output_tokens":1,"cache_creation_input_tokens":1200,"cache_read_input_tokens":8000}}}}
{"type":"assistant","uuid":"22222222-2222-4222-8222-222222222221","message":{"id":"msg_01ABC","role":"assistant","content":[{"type":"thinking","thinking":"先看目录"}],"stop_reason":null,"usage":{"input_tokens":3,"output_tokens":1,"cache_creation_input_tokens":1200,"cache_read_input_tokens":8000}}}
{"type":"assistant","uuid":"22222222-2222-4222-8222-222222222222","message":{"id":"msg_01ABC","role":"assistant","content":[{"type":"text","text":"我先列一下。"}],"stop_reason":null,"usage":{"input_tokens":3,"output_tokens":2,"cache_creation_input_tokens":1200,"cache_read_input_tokens":8000}}}
{"type":"assistant","uuid":"22222222-2222-4222-8222-222222222223","message":{"id":"msg_01ABC","role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Bash","input":{"command":"ls src"}}],"stop_reason":null,"usage":{"input_tokens":3,"output_tokens":1,"cache_creation_input_tokens":1200,"cache_read_input_tokens":8000}}}
{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":0,"output_tokens":86,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}
{"type":"stream_event","event":{"type":"message_stop"}}
{"type":"user","uuid":"33333333-3333-4333-8333-333333333333","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"a.rs\nb.rs"}]}}
{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_02DEF","type":"message","role":"assistant","model":"claude-sonnet-4-5","usage":{"input_tokens":12,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":9400}}}}
{"type":"assistant","uuid":"44444444-4444-4444-8444-444444444441","message":{"id":"msg_02DEF","role":"assistant","content":[{"type":"text","text":"目录里有"}],"stop_reason":null,"usage":{"input_tokens":12,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":9400}}}
{"type":"assistant","uuid":"44444444-4444-4444-8444-444444444442","message":{"id":"msg_02DEF","role":"assistant","content":[{"type":"text","text":" a.rs 和 b.rs。"}],"stop_reason":null,"usage":{"input_tokens":12,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":9400}}}
{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":0,"output_tokens":40,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}
{"type":"assistant","uuid":"44444444-4444-4444-8444-444444444443","message":{"id":"msg_02DEF","role":"assistant","content":[{"type":"text","text":" a.rs 和 b.rs。"}],"stop_reason":null,"usage":{"input_tokens":12,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":9400}}}
{"type":"result","subtype":"success","is_error":false,"uuid":"55555555-5555-4555-8555-555555555555","num_turns":2,"total_cost_usd":1.25,"usage":{"input_tokens":9999,"output_tokens":9999,"cache_creation_input_tokens":9999,"cache_read_input_tokens":9999},"modelUsage":{"claude-sonnet-4-5":{"inputTokens":9999,"outputTokens":9999,"costUSD":9}}}
"#;
