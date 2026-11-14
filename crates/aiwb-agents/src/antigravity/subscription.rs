//! 订阅额度。`agy -p /usage --output-format json` 是只读命令，不开会话也不调模型。
//!
//! 2026-11-09 agy 1.5.3 的回包：`command.data.groups[]` 是共用额度的模型组，每组 `buckets[]` 带
//! `window`（`weekly` / `5h`）、`remaining_fraction`（0–1）和 `reset_time`（RFC 3339）。
//! 2026-11-14 agy 1.5.9 组上还有 `description`，写着组里有哪些模型。写的是显示名：ACP 模型选项的 `name` 和它相同，
//! 或者后面多一个括号里的强度（组里 `GPT-OSS 120B`，选项 `GPT-OSS 120B (Medium)`）。

use std::time::Duration;

use chrono::DateTime;
use serde_json::Value;

use super::process;
use crate::mcp::exec;
use crate::AgentError;
use aiwb_core::models::{SubscriptionUsage, SubscriptionWindow};

const LIMIT: Duration = Duration::from_secs(60);

pub async fn fetch() -> Result<SubscriptionUsage, AgentError> {
    let program = process::resolve()?;
    let args: Vec<String> = ["-p", "/usage", "--output-format", "json"]
        .iter()
        .map(|arg| arg.to_string())
        .collect();
    let captured = exec::run_cli_with_env(&program, &args, &process::NO_SELF_UPDATE, LIMIT)
        .await
        .map_err(AgentError::Runtime)?;
    let stdout = exec::ensure_ok(captured).map_err(AgentError::Runtime)?;
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .ok_or_else(|| AgentError::Runtime("Antigravity 没有返回用量".into()))?;
    let payload: Value = serde_json::from_str(line.trim())
        .map_err(|err| AgentError::Runtime(format!("Antigravity 用量不是 JSON：{err}")))?;
    Ok(parse(&payload))
}

pub fn parse(payload: &Value) -> SubscriptionUsage {
    let mut windows = Vec::new();
    for group in payload
        .pointer("/command/data/groups")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = group.get("name").and_then(Value::as_str).unwrap_or("").trim();
        let models = group_models(group.get("description").and_then(Value::as_str).unwrap_or(""));
        for bucket in group.get("buckets").and_then(Value::as_array).into_iter().flatten() {
            let Some(id) = bucket.get("id").and_then(Value::as_str) else {
                continue;
            };
            let Some(remaining) = bucket.get("remaining_fraction").and_then(Value::as_f64) else {
                continue;
            };
            windows.push(SubscriptionWindow {
                id: id.to_string(),
                label: label(name, bucket.get("window").and_then(Value::as_str).unwrap_or("")),
                used_percent: None,
                remaining_percent: Some((remaining * 100.0).clamp(0.0, 100.0)),
                resets_at_ms: bucket
                    .get("reset_time")
                    .and_then(Value::as_str)
                    .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
                    .map(|at| at.timestamp_millis()),
                models: models.clone(),
            });
        }
    }
    SubscriptionUsage { windows }
}

/// 组的 `description` 是 `Models within this group: Gemini 4 Carbon, Gemini 3.8 Flash` 这样的一句，
/// 回包里没有单独的模型列表。不是这个开头时不猜，留空。
fn group_models(description: &str) -> Vec<String> {
    let Some(list) = description.trim().strip_prefix("Models within this group:") else {
        return Vec::new();
    };
    list.split(',')
        .map(|name| name.trim().trim_end_matches('.').trim())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

fn label(group: &str, window: &str) -> String {
    let window = match window {
        "weekly" => "每周",
        "5h" => "5 小时",
        other => other,
    };
    match (group.is_empty(), window.is_empty()) {
        (true, _) => window.to_string(),
        (_, true) => group.to_string(),
        _ => format!("{group} · {window}"),
    }
}
