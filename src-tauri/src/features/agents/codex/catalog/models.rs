//! `model/list` 和 `config/read` 里的模型字段。

use serde_json::Value;

use crate::models::{AgentModelOption, ModelServiceTier, ReasoningEffortOption};

/// `config/read` 的有效配置。外层可能是 `{ config: {...} }`，字段是 snake_case。
pub(in crate::features::agents::codex) struct CliModelConfig {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub service_tier: Option<String>,
}

pub(in crate::features::agents::codex) fn parse_cli_model_config(value: &Value) -> CliModelConfig {
    let config = value.get("config").unwrap_or(value);
    CliModelConfig {
        model: config_text(config, &["model"]),
        effort: config_text(config, &["model_reasoning_effort", "modelReasoningEffort"]),
        service_tier: config_text(config, &["service_tier", "serviceTier"])
            .filter(|tier| tier != "default"),
    }
}

/// `supportedReasoningEfforts` 上可选的短名。官方字段是 description；有 displayName 时用它。
fn effort_label(effort: &Value) -> Option<String> {
    for key in ["displayName", "display_name", "label", "name"] {
        let Some(text) = effort.get(key).and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        return Some(text.to_string());
    }
    None
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
                            label: effort_label(effort),
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
            show_in_picker: show_in_picker(&item),
            service_tiers: parse_service_tiers(&item),
            default_service_tier: config_text(&item, &["defaultServiceTier", "default_service_tier"])
                .filter(|tier| tier != "default"),
        });
    }
    models.sort_by(|a, b| b.is_default.cmp(&a.is_default).then(a.label.cmp(&b.label)));
    models
}

fn show_in_picker(item: &Value) -> bool {
    if let Some(flag) = item
        .get("showInPicker")
        .and_then(Value::as_bool)
        .or_else(|| item.get("show_in_picker").and_then(Value::as_bool))
    {
        return flag;
    }
    !matches!(
        item.get("visibility").and_then(Value::as_str).map(str::trim),
        Some("hide") | Some("none")
    )
}

/// `serviceTiers` 优先。只有旧的 `additionalSpeedTiers: ["fast"]` 时补一条空文案的 Fast 档，
/// 跟 `ModelPreset::supports_fast_mode` 一样：两条路都算支持快速档。
fn parse_service_tiers(item: &Value) -> Vec<ModelServiceTier> {
    let mut tiers = item
        .get("serviceTiers")
        .or_else(|| item.get("service_tiers"))
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(parse_one_tier).collect::<Vec<_>>())
        .unwrap_or_default();
    let legacy = item
        .get("additionalSpeedTiers")
        .or_else(|| item.get("additional_speed_tiers"))
        .and_then(Value::as_array);
    if let Some(list) = legacy {
        for value in list {
            let Some(id) = value.as_str().map(str::trim).filter(|text| !text.is_empty()) else {
                continue;
            };
            if tiers.iter().any(|tier| tier.id == id) {
                continue;
            }
            tiers.push(ModelServiceTier {
                id: id.to_string(),
                name: String::new(),
                description: String::new(),
            });
        }
    }
    tiers
}

fn parse_one_tier(tier: &Value) -> Option<ModelServiceTier> {
    if let Some(id) = tier.as_str() {
        let id = id.trim();
        if id.is_empty() {
            return None;
        }
        return Some(ModelServiceTier {
            id: id.to_string(),
            name: String::new(),
            description: String::new(),
        });
    }
    let id = tier.get("id").and_then(Value::as_str)?.trim();
    if id.is_empty() {
        return None;
    }
    Some(ModelServiceTier {
        id: id.to_string(),
        name: tier.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
        description: tier
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}
