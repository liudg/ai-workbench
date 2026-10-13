//! `model/list` 和 `config/read` 里的模型字段。

use serde_json::Value;

use crate::models::{AgentModelOption, ReasoningEffortOption};

/// `config/read` 的有效配置。外层可能是 `{ config: {...} }`，字段是 snake_case。
pub(in crate::features::agents::codex) struct CliModelConfig {
    pub model: Option<String>,
    pub effort: Option<String>,
}

pub(in crate::features::agents::codex) fn parse_cli_model_config(value: &Value) -> CliModelConfig {
    let config = value.get("config").unwrap_or(value);
    CliModelConfig {
        model: config_text(config, &["model"]),
        effort: config_text(config, &["model_reasoning_effort", "modelReasoningEffort"]),
    }
}

fn config_text(config: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        let Some(value) = config.get(*key) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        let Some(text) = value.as_str() else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        return Some(text.to_string());
    }
    None
}

pub(in crate::features::agents::codex) fn parse_models(value: &Value) -> Vec<AgentModelOption> {
    let list = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut models = Vec::new();
    for item in list {
        if item.get("hidden").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let id = item
            .get("model")
            .and_then(Value::as_str)
            .or_else(|| item.get("id").and_then(Value::as_str))
            .unwrap_or("")
            .trim()
            .to_string();
        if id.is_empty() {
            continue;
        }
        let label = item
            .get("displayName")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .unwrap_or(&id)
            .to_string();
        let efforts = item
            .get("supportedReasoningEfforts")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|effort| {
                        let id = effort
                            .get("reasoningEffort")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        if id.is_empty() {
                            return None;
                        }
                        Some(ReasoningEffortOption {
                            description: effort
                                .get("description")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            id,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let default_effort = item
            .get("defaultReasoningEffort")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .unwrap_or("")
            .to_string();
        models.push(AgentModelOption {
            id,
            label,
            description: item
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            is_default: item
                .get("isDefault")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            default_effort,
            efforts,
        });
    }
    models.sort_by(|a, b| b.is_default.cmp(&a.is_default).then(a.label.cmp(&b.label)));
    models
}
