//! 模型目录和会话里的模型参数。
//!
//! `initialize` 时声明 `clientCapabilities._meta.parameterizedModelPicker = true`，
//! Cursor 就按「基础模型 + 参数」给配置项（`agent-session` 的 `getModelPickerMode`）。
//! 目录来自扩展方法 `cursor/list_available_models`：每个模型带自己的 `configOptions`，
//! `category = thought_level` 的一项是推理强度，`id = fast` 的一项是 Fast 档。
//! 参数 id 因模型而异（`effort` / `reasoning_effort` / `reasoning`），所以按类别找，不写死 id。

use serde_json::Value;

use crate::acp::config::{current_value, find_fast, find_thought_level, select_values, FAST_TIER};
use aiwb_core::models::{
    AgentCapabilities, AgentCatalog, AgentKind, AgentModelOption, ModelServiceTier,
    ReasoningEffortOption,
};

pub fn empty_catalog() -> AgentCatalog {
    AgentCatalog {
        capabilities: AgentCapabilities::cursor(),
        agent: Some(AgentKind::CursorAgent),
        ..AgentCatalog::empty()
    }
}

pub fn apply_model_list(catalog: &mut AgentCatalog, payload: &Value) {
    let Some(models) = payload.get("models").and_then(Value::as_array) else {
        return;
    };
    catalog.models = models.iter().filter_map(model_option).collect();
}

pub fn has_models(payload: &Value) -> bool {
    payload
        .get("models")
        .and_then(Value::as_array)
        .is_some_and(|models| models.iter().any(|model| model_option(model).is_some()))
}

fn model_option(model: &Value) -> Option<AgentModelOption> {
    let id = model.get("value").and_then(Value::as_str)?.trim();
    if id.is_empty() {
        return None;
    }
    let label = model
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(id);
    let options = model
        .get("configOptions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let thought = find_thought_level(&options);
    let efforts = thought
        .map(|option| {
            select_values(option)
                .into_iter()
                .map(|(value, name)| ReasoningEffortOption {
                    id: value,
                    description: String::new(),
                    label: Some(name),
                })
                .collect()
        })
        .unwrap_or_default();
    let fast = find_fast(&options);
    let service_tiers = fast
        .map(|option| {
            vec![ModelServiceTier {
                id: FAST_TIER.into(),
                name: "Fast".into(),
                description: option
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                fast: true,
            }]
        })
        .unwrap_or_default();
    let default_service_tier = fast
        .filter(|option| current_value(option) == Some("true"))
        .map(|_| FAST_TIER.to_string());
    Some(AgentModelOption {
        id: id.to_string(),
        label: label.to_string(),
        description: String::new(),
        is_default: id == "default",
        default_effort: thought
            .and_then(current_value)
            .unwrap_or("")
            .to_string(),
        efforts,
        show_in_picker: true,
        service_tiers,
        default_service_tier,
        resolved_model: String::new(),
    })
}
