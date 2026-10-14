//! 会话 token 累计。
//!
//! 实时通知是 app-server `thread/tokenUsage/updated`。`tokenUsage.total` 是线程的绝对累计，
//! `tokenUsage.last` 是最近一次增量。两者相加会把增量算两次。
//! 对照 openai/codex `ThreadTokenUsage`（[#7268](https://github.com/openai/codex/pull/7268)）
//! 以及 rollout 里 `event_msg` / `token_count` 的 `total_token_usage`。
//!
//! 重新打开时读本会话自己的 rollout（`CODEX_HOME` 或 `~/.codex/sessions`）。
//! 文件名带线程 id。同一文件里每条 `token_count` 都是当时的累计，只留最后一条。

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::Value;

use super::tokens::{parse_token_usage, TokenUsage, TokenUsageInfo};
use crate::models::SessionEventBody;

pub(super) fn snapshot_from_info(info: &TokenUsageInfo) -> SessionEventBody {
    snapshot_from_total(&info.total)
}

/// `cached_input_tokens` 含在 `input_tokens` 里，拆开后各桶相加等于 `total_tokens`。
/// 没有 cache write 字段，就不编。
pub(super) fn snapshot_from_total(total: &TokenUsage) -> SessionEventBody {
    let cache_read = total.cached_input_tokens.max(0);
    let input = (total.input_tokens - cache_read).max(0);
    SessionEventBody::SessionUsage {
        scope: "snapshot".into(),
        key: None,
        input_tokens: Some(input),
        output_tokens: Some(total.output_tokens.max(0)),
        cache_read_tokens: Some(cache_read),
        cache_write_tokens: None,
    }
}

pub(super) fn latest_rollout_info(thread_id: &str) -> Option<TokenUsageInfo> {
    let id = thread_id.trim();
    if !safe_thread_id(id) {
        return None;
    }
    let path = find_rollout(&sessions_dir(), id)?;
    let text = std::fs::read_to_string(path).ok()?;
    usage_from_rollout_text(&text)
}

fn safe_thread_id(id: &str) -> bool {
    id.len() >= 8 && !id.contains(['/', '\\', '.'])
}

fn sessions_dir() -> PathBuf {
    let root = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| {
            let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
            match home {
                Some(home) => PathBuf::from(home).join(".codex"),
                None => PathBuf::from(".codex"),
            }
        });
    root.join("sessions")
}

pub(super) fn find_rollout(root: &Path, thread_id: &str) -> Option<PathBuf> {
    let mut best: Option<(SystemTime, PathBuf)> = None;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !name.ends_with(".jsonl") || !name.contains(thread_id) {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            let replace = best.as_ref().map(|(time, _)| modified >= *time).unwrap_or(true);
            if replace {
                best = Some((modified, path));
            }
        }
    }
    best.map(|(_, path)| path)
}

/// 只保留文件里最后一条 `token_count` 的 `total_token_usage`。
pub(super) fn usage_from_rollout_text(text: &str) -> Option<TokenUsageInfo> {
    let mut last = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(info) = token_count_info(&value) {
            last = Some(info);
        }
    }
    last
}

fn token_count_info(value: &Value) -> Option<TokenUsageInfo> {
    let payload = token_count_payload(value)?;
    let info = payload.get("info")?;
    if info.is_null() {
        return None;
    }
    let total = info.get("total_token_usage").or_else(|| info.get("total"))?;
    let last = info.get("last_token_usage").or_else(|| info.get("last")).unwrap_or(total);
    let window = info
        .get("model_context_window")
        .or_else(|| info.get("modelContextWindow"))
        .cloned()
        .unwrap_or(Value::Null);
    parse_token_usage(&serde_json::json!({
        "tokenUsage": {
            "total": camel_breakdown(total),
            "last": camel_breakdown(last),
            "modelContextWindow": window,
        }
    }))
}

fn token_count_payload(value: &Value) -> Option<&Value> {
    match value.get("type").and_then(Value::as_str)? {
        "token_count" => Some(value),
        "event_msg" => {
            let payload = value.get("payload")?;
            (payload.get("type").and_then(Value::as_str) == Some("token_count")).then_some(payload)
        }
        _ => None,
    }
}

fn camel_breakdown(value: &Value) -> Value {
    serde_json::json!({
        "inputTokens": field(value, "input_tokens", "inputTokens"),
        "cachedInputTokens": field(value, "cached_input_tokens", "cachedInputTokens"),
        "outputTokens": field(value, "output_tokens", "outputTokens"),
        "reasoningOutputTokens": field(value, "reasoning_output_tokens", "reasoningOutputTokens"),
        "totalTokens": field(value, "total_tokens", "totalTokens"),
    })
}

fn field(value: &Value, snake: &str, camel: &str) -> i64 {
    value
        .get(snake)
        .or_else(|| value.get(camel))
        .and_then(as_i64)
        .unwrap_or(0)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parts(body: &SessionEventBody) -> (i64, i64, i64, Option<i64>) {
        match body {
            SessionEventBody::SessionUsage {
                scope,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                ..
            } => {
                assert_eq!(scope, "snapshot");
                (
                    input_tokens.unwrap(),
                    output_tokens.unwrap(),
                    cache_read_tokens.unwrap(),
                    *cache_write_tokens,
                )
            }
            other => panic!("expected session usage, got {other:?}"),
        }
    }

    #[test]
    fn notification_uses_total_and_does_not_add_last() {
        let info = parse_token_usage(&json!({
            "threadId": "thread-1",
            "turnId": "1",
            "tokenUsage": {
                "total": {
                    "inputTokens": 5152,
                    "cachedInputTokens": 3072,
                    "outputTokens": 16,
                    "reasoningOutputTokens": 0,
                    "totalTokens": 5168
                },
                "last": {
                    "inputTokens": 4000,
                    "cachedInputTokens": 1000,
                    "outputTokens": 9,
                    "reasoningOutputTokens": 4,
                    "totalTokens": 4009
                },
                "modelContextWindow": 258400
            }
        }))
        .unwrap();
        let (input, output, cache_read, cache_write) = parts(&snapshot_from_info(&info));
        assert_eq!(input, 5152 - 3072);
        assert_eq!(output, 16);
        assert_eq!(cache_read, 3072);
        assert_eq!(cache_write, None);
        assert_eq!(input + output + cache_read, 5168);
    }

    #[test]
    fn rollout_keeps_only_the_latest_cumulative_total() {
        let text = r#"
{"timestamp":"2026-04-21T10:00:01Z","type":"session_meta","payload":{"id":"abc"}}
{"timestamp":"2026-04-21T10:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10,"reasoning_output_tokens":2,"total_tokens":110},"last_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10,"reasoning_output_tokens":2,"total_tokens":110},"model_context_window":258400}}}
{"timestamp":"2026-04-21T10:00:03Z","type":"event_msg","payload":{"type":"token_count","info":null}}
{"timestamp":"2026-04-21T10:00:04Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":250,"cached_input_tokens":80,"output_tokens":30,"reasoning_output_tokens":5,"total_tokens":280},"last_token_usage":{"input_tokens":150,"cached_input_tokens":40,"output_tokens":20,"reasoning_output_tokens":3,"total_tokens":170},"model_context_window":258400}}}
"#;
        let info = usage_from_rollout_text(text).unwrap();
        let (input, output, cache_read, _) = parts(&snapshot_from_info(&info));
        assert_eq!((input, output, cache_read), (170, 30, 80));
        assert_ne!(input + cache_read, 100 + 250);
    }

    #[test]
    fn rollout_file_is_the_newest_name_match() {
        let root = std::env::temp_dir().join(format!(
            "codex-usage-{}-{}",
            std::process::id(),
            "thread-aaaaaaaa"
        ));
        let _ = std::fs::remove_dir_all(&root);
        let day = root.join("2026").join("04").join("21");
        std::fs::create_dir_all(&day).unwrap();
        let thread = "019ab891-4c55-7790-9670-6c3b48c33281";
        let older = day.join(format!("rollout-2026-04-21T10-00-00-{thread}.jsonl"));
        let newer = day.join(format!("rollout-2026-04-21T11-00-00-{thread}_rev.jsonl"));
        let other = day.join("rollout-2026-04-21T12-00-00-other-thread.jsonl");
        std::fs::write(
            &older,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"total_tokens":11},"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1,"total_tokens":11}}}}"#,
        )
        .unwrap();
        std::fs::write(
            &newer,
            r#"{"type":"token_count","info":{"total":{"inputTokens":40,"cachedInputTokens":15,"outputTokens":5,"totalTokens":45},"last":{"inputTokens":5,"cachedInputTokens":0,"outputTokens":1,"totalTokens":6}}}"#,
        )
        .unwrap();
        std::fs::write(
            &other,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":999,"cached_input_tokens":0,"output_tokens":1,"total_tokens":1000}}}}"#,
        )
        .unwrap();
        filetime_touch(&older, SystemTime::UNIX_EPOCH).unwrap();
        filetime_touch(&newer, SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(10)).unwrap();
        let found = find_rollout(&root, thread).unwrap();
        assert_eq!(found, newer);
        let info = usage_from_rollout_text(&std::fs::read_to_string(&found).unwrap()).unwrap();
        let (input, output, cache_read, _) = parts(&snapshot_from_info(&info));
        assert_eq!((input, output, cache_read), (25, 5, 15));
        let _ = std::fs::remove_dir_all(&root);
    }

    fn filetime_touch(path: &Path, time: SystemTime) -> std::io::Result<()> {
        let file = std::fs::File::options().write(true).open(path)?;
        file.set_modified(time)
    }
}
