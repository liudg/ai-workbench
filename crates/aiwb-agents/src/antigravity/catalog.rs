//! 模型目录。打开会话的回包里有两份：
//! - `configOptions` 的 `model` 项是可选的模型系列（`gemini-4-argon`），`thought_level` 是当前系列的强度。
//! - `models.availableModels` 是系列加强度的组合（`gemini-4-argon-medium`），用它得出每个系列有哪些强度。
//!
//! 没有强度变体的系列（`gpt-oss-120b-medium`）在两份里 id 相同，强度留空。

use serde_json::Value;

use crate::acp::config::{self, MODEL_CONFIG};
use aiwb_core::models::{
    AgentCapabilities, AgentCatalog, AgentKind, AgentModelOption, ReasoningEffortOption,
};

pub fn empty_catalog() -> AgentCatalog {
    AgentCatalog {
        capabilities: AgentCapabilities::antigravity(),
        agent: Some(AgentKind::Antigravity),
        ..AgentCatalog::empty()
    }
}

pub fn apply_session(catalog: &mut AgentCatalog, payload: &Value) {
    let Some(options) = config::config_options(payload) else {
        return;
    };
    let Some(model) = options
        .iter()
        .find(|option| option.get("id").and_then(Value::as_str) == Some(MODEL_CONFIG))
    else {
        return;
    };
    let current_model = config::current_value(model).unwrap_or("").to_string();
    let current_effort = config::find_thought_level(&options)
        .and_then(config::current_value)
        .unwrap_or("")
        .to_string();
    let variants: Vec<(String, String)> = payload
        .pointer("/models/availableModels")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let id = model.get("modelId").and_then(Value::as_str)?;
                    Some((id.to_string(), model.get("name").and_then(Value::as_str).unwrap_or(id).to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    let models: Vec<AgentModelOption> = config::select_values(model)
        .into_iter()
        .map(|(id, label)| {
            let efforts = efforts_of(&id, &variants);
            let default_effort = if id == current_model && efforts.iter().any(|effort| effort.id == current_effort) {
                current_effort.clone()
            } else if efforts.iter().any(|effort| effort.id == "medium") {
                "medium".to_string()
            } else {
                efforts.first().map(|effort| effort.id.clone()).unwrap_or_default()
            };
            AgentModelOption {
                is_default: id == current_model,
                id,
                label,
                description: String::new(),
                default_effort,
                efforts,
                show_in_picker: true,
                service_tiers: Vec::new(),
                default_service_tier: None,
                resolved_model: String::new(),
            }
        })
        .collect();
    if !models.is_empty() {
        catalog.models = models;
    }
}

fn efforts_of(family: &str, variants: &[(String, String)]) -> Vec<ReasoningEffortOption> {
    const ORDER: [(&str, &str); 3] = [("low", "Low"), ("medium", "Medium"), ("high", "High")];
    ORDER
        .iter()
        .filter(|(effort, _)| variants.iter().any(|(id, _)| id == &format!("{family}-{effort}")))
        .map(|(effort, label)| ReasoningEffortOption {
            id: (*effort).to_string(),
            description: String::new(),
            label: Some((*label).to_string()),
        })
        .collect()
}
