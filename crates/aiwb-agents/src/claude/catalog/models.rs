//! 模型行。解析 CLI 的 models，并把报告的名字对齐到目录 id。
//!
//! 对齐顺序只有这一处：精确的 id、`resolvedModel`、label，然后才剥括号后缀。
//! `is_default` 也由这里写下，解析时不再各判一次。

use serde_json::Value;

use aiwb_core::models::{AgentCatalog, AgentModelOption, ReasoningEffortOption};

use super::nonempty;

pub(super) fn model_from_value(value: &Value) -> Option<AgentModelOption> {
    let id = nonempty(value.get("value").and_then(Value::as_str))
        .or_else(|| nonempty(value.get("id").and_then(Value::as_str)))
        .or_else(|| nonempty(value.get("model").and_then(Value::as_str)))
        .or_else(|| nonempty(value.get("name").and_then(Value::as_str)))?;
    let label = nonempty(value.get("displayName").and_then(Value::as_str))
        .or_else(|| nonempty(value.get("display_name").and_then(Value::as_str)))
        .or_else(|| nonempty(value.get("label").and_then(Value::as_str)))
        .unwrap_or(id);
    let resolved_model = nonempty(value.get("resolvedModel").and_then(Value::as_str))
        .or_else(|| nonempty(value.get("resolved_model").and_then(Value::as_str)))
        .unwrap_or("")
        .to_string();
    let description = value
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let efforts = value
        .get("supportedEffortLevels")
        .and_then(Value::as_array)
        .map(|levels| levels.iter().filter_map(effort_from_value).collect())
        .unwrap_or_default();
    Some(AgentModelOption {
        id: id.to_string(),
        label: label.to_string(),
        description,
        is_default: false,
        show_in_picker: true,
        default_effort: String::new(),
        efforts,
        service_tiers: Vec::new(),
        default_service_tier: None,
        resolved_model,
    })
}

fn effort_from_value(value: &Value) -> Option<ReasoningEffortOption> {
    if let Some(id) = value
        .as_str()
        .map(str::trim)
        .filter(|level| !level.is_empty())
    {
        return Some(ReasoningEffortOption {
            id: id.to_string(),
            description: String::new(),
            label: None,
        });
    }
    let id = nonempty(value.get("id").and_then(Value::as_str))
        .or_else(|| nonempty(value.get("value").and_then(Value::as_str)))
        .or_else(|| nonempty(value.get("level").and_then(Value::as_str)))?;
    Some(ReasoningEffortOption {
        id: id.to_string(),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        label: nonempty(value.get("displayName").and_then(Value::as_str))
            .or_else(|| nonempty(value.get("display_name").and_then(Value::as_str)))
            .or_else(|| nonempty(value.get("label").and_then(Value::as_str)))
            .map(str::to_string),
    })
}

fn placeholder_model(id: &str, is_default: bool) -> AgentModelOption {
    AgentModelOption {
        id: id.to_string(),
        label: id.to_string(),
        description: String::new(),
        is_default,
        show_in_picker: true,
        default_effort: String::new(),
        efforts: Vec::new(),
        service_tiers: Vec::new(),
        default_service_tier: None,
        resolved_model: String::new(),
    }
}

/// 把 CLI 报告的模型名对齐到目录条目。
/// `get_settings.applied.model` 常是 `resolvedModel`（如 gpt-6.1-sol），
/// 而 `list_models` 的 id 是别名（opus/sonnet）。对不上时补一行，不写空 efforts。
pub(super) fn ensure_listed(catalog: &mut AgentCatalog, model_id: &str) -> String {
    let raw = model_id.trim();
    if raw.is_empty() {
        return String::new();
    }
    if let Some(index) = find_model_index(catalog, raw) {
        let id = catalog.models[index].id.clone();
        mark_default(catalog, &id);
        return id;
    }
    let needle = strip_model_brackets(raw);
    mark_default(catalog, "");
    catalog.models.insert(0, placeholder_model(&needle, true));
    needle
}

fn mark_default(catalog: &mut AgentCatalog, id: &str) {
    for model in &mut catalog.models {
        model.is_default = !id.is_empty() && model.id == id;
    }
}

/// CLI 刚确认的模型写成线程模型，并对齐到目录 id。
pub(in crate::claude) fn adopt_thread_model(
    catalog: &mut AgentCatalog,
    model: &str,
) {
    let model = model.trim();
    if model.is_empty() {
        return;
    }
    catalog.cli_config_read = Some(true);
    catalog.thread_model = Some(ensure_listed(catalog, model));
}

/// 已有线程模型再对齐一次。不改 `cli_config_read`，也不换成另一条设置里的名字。
pub(super) fn align_thread_model(catalog: &mut AgentCatalog) {
    if let Some(model) = catalog.thread_model.clone() {
        catalog.thread_model = Some(ensure_listed(catalog, &model));
    }
}

fn find_model_index(catalog: &AgentCatalog, raw: &str) -> Option<usize> {
    // 先精确：id → resolvedModel → label，避免 gpt-6.1-sol[1m] 剥括号后误命中 gpt-6.1-sol。
    if let Some(index) = catalog.models.iter().position(|model| model.id == raw) {
        return Some(index);
    }
    if let Some(index) = position_resolved(catalog, raw) {
        return Some(index);
    }
    if let Some(index) = catalog.models.iter().position(|model| model.label == raw) {
        return Some(index);
    }
    let stripped = strip_model_brackets(raw);
    if stripped != raw {
        if let Some(index) = position_resolved(catalog, &stripped) {
            return Some(index);
        }
        if let Some(index) = catalog
            .models
            .iter()
            .position(|model| model.label == stripped)
        {
            return Some(index);
        }
        if let Some(index) = catalog.models.iter().position(|model| model.id == stripped) {
            return Some(index);
        }
    }
    None
}

fn position_resolved(catalog: &AgentCatalog, needle: &str) -> Option<usize> {
    catalog
        .models
        .iter()
        .position(|model| !model.resolved_model.is_empty() && model.resolved_model == needle)
}

fn strip_model_brackets(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(open) = trimmed.rfind('[') {
        if trimmed.ends_with(']') && open > 0 {
            return trimmed[..open].trim().to_string();
        }
    }
    trimmed.to_string()
}
