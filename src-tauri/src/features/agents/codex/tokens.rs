//! `thread/tokenUsage/updated`（v2 `ThreadTokenUsage`）与 TUI 的用量换算。
//!
//! 公式对照 `tui/src/token_usage.rs`（`BASELINE_TOKENS`、
//! `percent_of_context_window_remaining`）与 `tui/src/status/helpers.rs::format_tokens_compact`。

use serde_json::Value;

const BASELINE_TOKENS: i64 = 12000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct TokenUsage {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct TokenUsageInfo {
    pub total: TokenUsage,
    pub last: TokenUsage,
    pub model_context_window: Option<i64>,
}

fn breakdown(value: Option<&Value>) -> TokenUsage {
    let field = |key: &str| {
        value
            .and_then(|value| value.get(key))
            .and_then(Value::as_i64)
            .unwrap_or(0)
    };
    TokenUsage {
        input_tokens: field("inputTokens"),
        cached_input_tokens: field("cachedInputTokens"),
        output_tokens: field("outputTokens"),
        reasoning_output_tokens: field("reasoningOutputTokens"),
        total_tokens: field("totalTokens"),
    }
}

/// 通知参数 `{ threadId, turnId, tokenUsage: { total, last, modelContextWindow } }`。
pub(super) fn parse_token_usage(params: &Value) -> Option<TokenUsageInfo> {
    let usage = params.get("tokenUsage")?;
    Some(TokenUsageInfo {
        total: breakdown(usage.get("total")),
        last: breakdown(usage.get("last")),
        model_context_window: usage.get("modelContextWindow").and_then(Value::as_i64),
    })
}

impl TokenUsage {
    pub(super) fn is_zero(&self) -> bool {
        self.total_tokens == 0
    }

    fn cached_input(&self) -> i64 {
        self.cached_input_tokens.max(0)
    }

    pub(super) fn non_cached_input(&self) -> i64 {
        (self.input_tokens - self.cached_input()).max(0)
    }

    /// 非缓存输入 + 输出。
    pub(super) fn blended_total(&self) -> i64 {
        (self.non_cached_input() + self.output_tokens.max(0)).max(0)
    }

    pub(super) fn tokens_in_context_window(&self) -> i64 {
        self.total_tokens
    }

    pub(super) fn percent_of_context_window_remaining(&self, context_window: i64) -> i64 {
        if context_window <= BASELINE_TOKENS {
            return 0;
        }
        let effective_window = context_window - BASELINE_TOKENS;
        let used = (self.tokens_in_context_window() - BASELINE_TOKENS).max(0);
        let remaining = (effective_window - used).max(0);
        ((remaining as f64 / effective_window as f64) * 100.0)
            .clamp(0.0, 100.0)
            .round() as i64
    }
}

impl TokenUsageInfo {
    /// `ChatWidget::context_remaining_percent`：按最近一轮用量算。
    pub(super) fn remaining_percent(&self) -> Option<i64> {
        self.model_context_window
            .map(|window| self.last.percent_of_context_window_remaining(window))
    }

    /// `ChatWidget::plan_implementation_context_usage_label`。
    pub(super) fn plan_usage_label(&self) -> Option<String> {
        if let Some(percent) = self.remaining_percent() {
            let used = 100 - percent.clamp(0, 100);
            return (used > 0).then(|| format!("{used}% used"));
        }
        let tokens = self.total.tokens_in_context_window();
        (tokens > 0).then(|| format!("{} used", format_tokens_compact(tokens)))
    }
}

pub(super) fn format_tokens_compact(value: i64) -> String {
    let value = value.max(0);
    if value == 0 {
        return "0".to_string();
    }
    if value < 1_000 {
        return value.to_string();
    }
    let value_f64 = value as f64;
    let (scaled, suffix) = if value >= 1_000_000_000_000 {
        (value_f64 / 1_000_000_000_000.0, "T")
    } else if value >= 1_000_000_000 {
        (value_f64 / 1_000_000_000.0, "B")
    } else if value >= 1_000_000 {
        (value_f64 / 1_000_000.0, "M")
    } else {
        (value_f64 / 1_000.0, "K")
    };
    let decimals = if scaled < 10.0 {
        2
    } else if scaled < 100.0 {
        1
    } else {
        0
    };
    let mut formatted = format!("{scaled:.decimals$}");
    if formatted.contains('.') {
        while formatted.ends_with('0') {
            formatted.pop();
        }
        if formatted.ends_with('.') {
            formatted.pop();
        }
    }
    format!("{formatted}{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compact_tokens_match_the_tui() {
        assert_eq!(format_tokens_compact(0), "0");
        assert_eq!(format_tokens_compact(999), "999");
        assert_eq!(format_tokens_compact(1_200), "1.2K");
        assert_eq!(format_tokens_compact(123_456), "123K");
        assert_eq!(format_tokens_compact(12_345_678), "12.3M");
    }

    #[test]
    fn plan_label_uses_last_turn_against_the_window() {
        let info = parse_token_usage(&json!({
            "threadId": "t",
            "turnId": "u",
            "tokenUsage": {
                "total": { "totalTokens": 90000, "inputTokens": 80000, "cachedInputTokens": 0, "outputTokens": 10000, "reasoningOutputTokens": 0 },
                "last": { "totalTokens": 62000, "inputTokens": 60000, "cachedInputTokens": 0, "outputTokens": 2000, "reasoningOutputTokens": 0 },
                "modelContextWindow": 112000
            }
        }))
        .unwrap();
        assert_eq!(info.remaining_percent(), Some(50));
        assert_eq!(info.plan_usage_label().as_deref(), Some("50% used"));
        let fresh = TokenUsageInfo {
            model_context_window: None,
            ..TokenUsageInfo::default()
        };
        assert!(fresh.plan_usage_label().is_none());
        let unknown_window = TokenUsageInfo {
            total: TokenUsage {
                total_tokens: 1_500,
                ..TokenUsage::default()
            },
            ..TokenUsageInfo::default()
        };
        assert_eq!(unknown_window.plan_usage_label().as_deref(), Some("1.5K used"));
    }
}
