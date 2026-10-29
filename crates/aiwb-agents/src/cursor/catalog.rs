//! 模型目录和会话里的模型参数。
//!
//! `initialize` 时声明 `clientCapabilities._meta.parameterizedModelPicker = true`，
//! Cursor 就按「基础模型 + 参数」给配置项（`agent-session` 的 `getModelPickerMode`）。
//! 目录来自扩展方法 `cursor/list_available_models`：每个模型带自己的 `configOptions`，
//! `category = thought_level` 的一项是推理强度，`id = fast` 的一项是 Fast 档。
//! 参数 id 因模型而异（`effort` / `reasoning_effort` / `reasoning`），所以按类别找，不写死 id。

use serde_json::Value;

use aiwb_core::models::{
    AgentCapabilities, AgentCatalog, AgentKind, AgentModelOption, ModelServiceTier,
    ReasoningEffortOption, SlashCommand,
};

pub const MODEL_CONFIG: &str = "model";
pub const FAST_CONFIG: &str = "fast";
pub const FAST_TIER: &str = "fast";
const THOUGHT_LEVEL: &str = "thought_level";

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

/// 会话里当前的模型、强度和 Fast 参数。`configOptions` 每次 `set_config_option` 都整份返回。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelConfig {
    pub model: Option<String>,
    pub effort_id: Option<String>,
    pub effort: Option<String>,
    pub effort_values: Vec<String>,
    pub fast: Option<bool>,
}

pub fn read_config(options: &[Value]) -> ModelConfig {
    let model = options
        .iter()
        .find(|option| option.get("id").and_then(Value::as_str) == Some(MODEL_CONFIG))
        .and_then(current_value)
        .map(str::to_string);
    let thought = find_thought_level(options);
    ModelConfig {
        model,
        effort_id: thought
            .and_then(|option| option.get("id").and_then(Value::as_str))
            .map(str::to_string),
        effort: thought.and_then(current_value).map(str::to_string),
        effort_values: thought
            .map(|option| select_values(option).into_iter().map(|(value, _)| value).collect())
            .unwrap_or_default(),
        fast: find_fast(options).and_then(current_value).map(|value| value == "true"),
    }
}

pub fn config_options(payload: &Value) -> Option<Vec<Value>> {
    payload.get("configOptions").and_then(Value::as_array).cloned()
}

/// `available_commands_update`。ACP 命令名不带斜杠，作曲栏的斜杠菜单要带。
pub fn commands(update: &Value) -> Vec<SlashCommand> {
    update
        .get("availableCommands")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = item.get("name").and_then(Value::as_str)?.trim();
                    if name.is_empty() {
                        return None;
                    }
                    Some(SlashCommand {
                        name: format!("/{}", name.trim_start_matches('/')),
                        hint: item
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        takes_args: item.get("input").is_some_and(|input| !input.is_null()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn find_thought_level(options: &[Value]) -> Option<&Value> {
    options
        .iter()
        .find(|option| option.get("category").and_then(Value::as_str) == Some(THOUGHT_LEVEL))
}

fn find_fast(options: &[Value]) -> Option<&Value> {
    options.iter().find(|option| {
        option.get("id").and_then(Value::as_str) == Some(FAST_CONFIG)
            && select_values(option).iter().any(|(value, _)| value == "true")
    })
}

fn current_value(option: &Value) -> Option<&str> {
    option.get("currentValue").and_then(Value::as_str)
}

fn select_values(option: &Value) -> Vec<(String, String)> {
    option
        .get("options")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let value = item.get("value").and_then(Value::as_str)?.to_string();
                    let name = item
                        .get("name")
                        .and_then(Value::as_str)
                        .map(|name| name.trim_matches('\u{200b}').trim().to_string())
                        .filter(|name| !name.is_empty())
                        .unwrap_or_else(|| value.clone());
                    Some((value, name))
                })
                .collect()
        })
        .unwrap_or_default()
}
