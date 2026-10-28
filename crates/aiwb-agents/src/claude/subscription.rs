//! Claude Code 订阅额度。短命 `--print` 进程发 `get_usage`，不发用户消息，读完就退出。
//!
//! 2026-10-16，Claude Code 2.1.300：`control_request` 的 `subtype=get_usage` 成功回包有
//! `rate_limits`。窗口字段是 `utilization`（已用百分比，0–100）和 `resets_at`（ISO 8601）。
//! `model_scoped` 是按模型拆开的同一类窗口。`rate_limits_available` 为 false 时
//! `rate_limits` 为 null（API key、Bedrock、Vertex，或没有 profile scope）。
//! 本机用户设置是 `ANTHROPIC_AUTH_TOKEN` 加第三方 base URL，实读就是这一支。

use std::time::Duration;

use chrono::DateTime;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::mpsc;
use tokio::time::timeout;

use super::command::{self, Launch};
use super::control;
use super::history;
use super::process;
use aiwb_proc::decode_child_bytes;
use crate::AgentError;
use aiwb_core::models::{SubscriptionUsage, SubscriptionWindow};

pub async fn fetch() -> Result<SubscriptionUsage, AgentError> {
    let bin = process::resolve_claude_bin()?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let cwd = std::env::temp_dir().join("ai-workbench-claude-usage");
    std::fs::create_dir_all(&cwd).map_err(|err| AgentError::Runtime(err.to_string()))?;
    let args = command::cli_args(&Launch {
        session_id: session_id.clone(),
        resume: false,
        permission_mode: "default".into(),
        model: None,
        effort: None,
        writable_roots: Vec::new(),
    });
    let mut child = process::spawn(&bin, &args, &cwd)?;
    let result = talk(&mut child).await;
    let _ = child.start_kill();
    let _ = timeout(Duration::from_secs(2), child.wait()).await;
    let _ = history::remove_session_file(&session_id);
    let project = history::projects_dir().join(history::sanitize_path(&cwd.to_string_lossy()));
    if project.starts_with(history::projects_dir()) {
        let _ = std::fs::remove_dir_all(project);
    }
    result
}

async fn talk(child: &mut Child) -> Result<SubscriptionUsage, AgentError> {
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AgentError::Runtime("Claude Code 没有标准输入".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AgentError::Runtime("Claude Code 没有标准输出".into()))?;
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr);
            let mut raw = Vec::new();
            loop {
                raw.clear();
                if lines.read_until(b'\n', &mut raw).await.unwrap_or(0) == 0 {
                    break;
                }
            }
        });
    }
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
    let (line_tx, mut line_rx) = mpsc::unbounded_channel::<Value>();
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
            if message.get("type").and_then(Value::as_str) == Some("control_request") {
                answer_request(&reply, &message);
                continue;
            }
            let _ = line_tx.send(message);
        }
    });

    let init_id = "req_1_subusage";
    send(
        &out_tx,
        &control::control_request(init_id, control::initialize_request()),
    );
    wait_ok(&mut line_rx, init_id, Duration::from_secs(20)).await?;
    let usage_id = "req_2_subusage";
    send(
        &out_tx,
        &control::control_request(
            usage_id,
            json!({"subtype": "get_usage", "skip_behaviors": true}),
        ),
    );
    let payload = wait_ok(&mut line_rx, usage_id, Duration::from_secs(20)).await?;
    Ok(SubscriptionUsage {
        windows: windows_from_usage(&payload),
    })
}

fn send(out: &mpsc::UnboundedSender<String>, value: &Value) {
    if let Ok(line) = serde_json::to_string(value) {
        let _ = out.send(line);
    }
}

fn answer_request(out: &mpsc::UnboundedSender<String>, message: &Value) {
    let id = message
        .get("request_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let subtype = message
        .get("request")
        .and_then(|request| request.get("subtype"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let response = if subtype == "can_use_tool" {
        json!({"behavior": "deny", "message": "订阅用量查询不执行工具"})
    } else {
        json!({})
    };
    send(out, &control::control_success(id, response));
}

async fn wait_ok(
    rx: &mut mpsc::UnboundedReceiver<Value>,
    id: &str,
    budget: Duration,
) -> Result<Value, AgentError> {
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(AgentError::Runtime("读取 Claude 订阅用量超时".into()));
        }
        let message = match timeout(remaining, rx.recv()).await {
            Ok(Some(message)) => message,
            _ => return Err(AgentError::Runtime("读取 Claude 订阅用量超时".into())),
        };
        if message.get("type").and_then(Value::as_str) != Some("control_response") {
            continue;
        }
        let Some((response_id, result)) = control::parse_control_response(&message) else {
            continue;
        };
        if response_id != id {
            continue;
        }
        return result.map_err(AgentError::Runtime);
    }
}

pub(super) fn windows_from_usage(payload: &Value) -> Vec<SubscriptionWindow> {
    let Some(limits) = payload.get("rate_limits").filter(|value| value.is_object()) else {
        return Vec::new();
    };
    let mut windows = Vec::new();
    let Some(object) = limits.as_object() else {
        return windows;
    };
    for (key, value) in object {
        if key == "model_scoped" {
            push_named_list(&mut windows, "model", value, "display_name");
            continue;
        }
        if key == "limits" {
            push_named_list(&mut windows, "limit", value, "kind");
            continue;
        }
        push_window(&mut windows, key.clone(), label_for_key(key), value);
    }
    windows
}

fn push_named_list(out: &mut Vec<SubscriptionWindow>, prefix: &str, value: &Value, name_key: &str) {
    let Some(items) = value.as_array() else {
        return;
    };
    for (index, item) in items.iter().enumerate() {
        let name = item
            .get(name_key)
            .or_else(|| {
                item.get("scope")
                    .and_then(|scope| scope.get("model"))
                    .and_then(|model| model.get("display_name"))
            })
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{prefix}-{index}"));
        push_window(out, format!("{prefix}:{index}:{name}"), name, item);
    }
}

fn push_window(out: &mut Vec<SubscriptionWindow>, id: String, label: String, value: &Value) {
    if !value.is_object() {
        return;
    }
    let used = value
        .get("utilization")
        .or_else(|| value.get("percent"))
        .or_else(|| value.get("used_percent"))
        .and_then(Value::as_f64);
    let remaining = value.get("remaining_percent").and_then(Value::as_f64);
    if used.is_none() && remaining.is_none() {
        return;
    }
    out.push(SubscriptionWindow {
        id,
        label,
        used_percent: used,
        remaining_percent: remaining,
        resets_at_ms: value
            .get("resets_at")
            .or_else(|| value.get("resetsAt"))
            .and_then(resets_ms),
    });
}

fn label_for_key(key: &str) -> String {
    match key {
        "five_hour" => "5 小时".to_string(),
        "seven_day" => "7 天".to_string(),
        "seven_day_opus" => "7 天 Opus".to_string(),
        "seven_day_sonnet" => "7 天 Sonnet".to_string(),
        "seven_day_oauth_apps" => "7 天应用".to_string(),
        other => other.replace('_', " "),
    }
}

fn resets_ms(value: &Value) -> Option<i64> {
    if let Some(text) = value.as_str() {
        return DateTime::parse_from_rfc3339(text)
            .ok()
            .map(|time| time.timestamp_millis());
    }
    let number = value.as_i64().or_else(|| value.as_f64().map(|number| number as i64))?;
    if number <= 0 {
        return None;
    }
    if number >= 1_000_000_000_000 {
        Some(number)
    } else {
        number.checked_mul(1000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn schema_windows_keep_used_percent_and_reset() {
        let payload = json!({
            "subscription_type": "pro",
            "rate_limits_available": true,
            "rate_limits": {
                "five_hour": { "utilization": 38, "resets_at": "2026-10-16T04:00:00Z" },
                "seven_day": { "utilization": 12, "resets_at": "2026-10-20T00:00:00Z" },
                "model_scoped": [
                    { "display_name": "Opus", "utilization": 40, "resets_at": "2026-10-20T00:00:00Z" }
                ]
            }
        });
        let windows = windows_from_usage(&payload);
        assert_eq!(windows.len(), 3);
        let five_hour = windows.iter().find(|window| window.id == "five_hour").unwrap();
        assert_eq!(five_hour.label, "5 小时");
        assert_eq!(five_hour.used_percent, Some(38.0));
        assert_eq!(five_hour.resets_at_ms, Some(1_792_123_200_000));
        let opus = windows.iter().find(|window| window.label == "Opus").unwrap();
        assert_eq!(opus.used_percent, Some(40.0));
        assert!(windows.iter().any(|window| window.id == "seven_day" && window.label == "7 天"));
    }

    #[test]
    fn unavailable_account_has_no_windows() {
        let payload = json!({
            "subscription_type": null,
            "rate_limits_available": false,
            "rate_limits": null
        });
        assert!(windows_from_usage(&payload).is_empty());
    }
}
