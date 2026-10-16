//! Codex 订阅额度。短命 `codex app-server` 读 `account/rateLimits/read`，不碰已打开的会话。
//!
//! 2026-10-16，本机 Codex CLI 0.162.1 的回包里，`rateLimitsByLimitId` 与 `rateLimits`
//! 是同一份快照。窗口在 `primary` / `secondary`：`usedPercent` 为已用百分比，
//! `resetsAt` 为 Unix 秒，`windowDurationMins` 用来标这个窗口。

use std::time::Duration;

use serde_json::Value;

use super::directory_client::RpcClient;
use crate::features::agents::AgentError;
use crate::models::{SubscriptionUsage, SubscriptionWindow};

pub async fn fetch() -> Result<SubscriptionUsage, AgentError> {
    let client = RpcClient::spawn().await.map_err(AgentError::Runtime)?;
    let result = client
        .request(
            "account/rateLimits/read",
            Value::Null,
            Duration::from_secs(20),
        )
        .await;
    client.shutdown().await;
    let value = result.map_err(AgentError::Runtime)?;
    Ok(SubscriptionUsage {
        windows: windows_from_rate_limits(&value),
    })
}

pub(super) fn windows_from_rate_limits(response: &Value) -> Vec<SubscriptionWindow> {
    let mut windows = Vec::new();
    for snapshot in snapshots(response) {
        let limit_id = snapshot
            .get("limitId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .unwrap_or("limit");
        for (slot, secondary) in [("primary", false), ("secondary", true)] {
            let Some(window) = snapshot.get(slot).filter(|value| value.is_object()) else {
                continue;
            };
            let Some(used) = window.get("usedPercent").and_then(Value::as_f64) else {
                continue;
            };
            let minutes = window.get("windowDurationMins").and_then(Value::as_i64);
            windows.push(SubscriptionWindow {
                id: format!("{limit_id}:{slot}"),
                label: window_label(minutes, secondary),
                used_percent: Some(used),
                remaining_percent: None,
                resets_at_ms: window.get("resetsAt").and_then(unix_ms),
            });
        }
    }
    windows
}

/// `rateLimitsByLimitId` 和 `rateLimits` 在实读里是同一份。只取其中一份，避免同一个窗口画两次。
fn snapshots(response: &Value) -> Vec<&Value> {
    let from_map: Vec<&Value> = response
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object)
        .map(|map| map.values().filter(|value| value.is_object()).collect())
        .unwrap_or_default();
    if !from_map.is_empty() {
        return from_map;
    }
    response
        .get("rateLimits")
        .filter(|value| value.is_object())
        .into_iter()
        .collect()
}

fn unix_ms(value: &Value) -> Option<i64> {
    let seconds = value.as_i64().filter(|seconds| *seconds > 0)?;
    seconds.checked_mul(1000)
}

fn window_label(minutes: Option<i64>, secondary: bool) -> String {
    const HOUR: i64 = 60;
    const DAY: i64 = 24 * HOUR;
    let approx = |value: i64, expected: i64| {
        let (value, expected) = (value as f64, expected as f64);
        value >= expected * 0.95 && value <= expected * 1.05
    };
    let named = minutes.and_then(|minutes| {
        let minutes = minutes.max(0);
        if approx(minutes, 5 * HOUR) {
            Some("5 小时")
        } else if approx(minutes, DAY) {
            Some("每日")
        } else if approx(minutes, 7 * DAY) {
            Some("每周")
        } else if approx(minutes, 30 * DAY) {
            Some("每月")
        } else {
            None
        }
    });
    match named {
        Some(label) => label.to_string(),
        None if secondary => "次要额度".to_string(),
        None => "额度".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn live_shape_keeps_one_weekly_window() {
        let response = json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": { "usedPercent": 37, "windowDurationMins": 10080, "resetsAt": 1_800_000_000 },
                "secondary": null
            },
            "rateLimitsByLimitId": {
                "codex": {
                    "limitId": "codex",
                    "primary": { "usedPercent": 37, "windowDurationMins": 10080, "resetsAt": 1_800_000_000 },
                    "secondary": null
                }
            }
        });
        let windows = windows_from_rate_limits(&response);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].id, "codex:primary");
        assert_eq!(windows[0].label, "每周");
        assert_eq!(windows[0].used_percent, Some(37.0));
        assert_eq!(windows[0].resets_at_ms, Some(1_800_000_000_000));
    }

    #[test]
    fn primary_and_secondary_stay_distinct() {
        let response = json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": { "usedPercent": 20, "windowDurationMins": 300, "resetsAt": 100 },
                "secondary": { "usedPercent": 80, "windowDurationMins": 10080, "resetsAt": 200 }
            }
        });
        let windows = windows_from_rate_limits(&response);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].label, "5 小时");
        assert_eq!(windows[1].label, "每周");
        assert_eq!(windows[1].used_percent, Some(80.0));
    }

    #[test]
    fn missing_payload_has_no_windows() {
        assert!(windows_from_rate_limits(&json!({})).is_empty());
        assert!(windows_from_rate_limits(&json!({"rateLimits": {"primary": null}})).is_empty());
    }
}
