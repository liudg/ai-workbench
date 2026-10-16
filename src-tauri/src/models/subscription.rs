//! 订阅额度窗口。各适配器把原生 CLI 的回包收成同一份结构，界面只渲染它。

use serde::{Deserialize, Serialize};

/// 一个用量窗口。已用和剩余至少有一个；重置时间可以没有。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubscriptionWindow {
    pub id: String,
    pub label: String,
    /// 已用百分比，0–100。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    /// 剩余百分比，0–100。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_percent: Option<f64>,
    /// 重置时刻，Unix 毫秒。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubscriptionUsage {
    pub windows: Vec<SubscriptionWindow>,
}

impl SubscriptionUsage {
    pub fn empty() -> Self {
        Self { windows: Vec::new() }
    }
}
