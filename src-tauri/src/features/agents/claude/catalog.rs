//! initialize / list_models / get_settings 的目录。只写入 CLI 报告的字段。
//!
//! `ModelInfo` 用 `value` / `displayName` / `description` / `supportedEffortLevels`
//! （官方 SDK `sdk.d.ts` 约 L1396）。斜杠命令的 `argumentHint` 非空才算带参数
//! （`SlashCommand` 约 L9431）。`skills` 字段缺失时不把命令复制成技能。

use serde_json::Value;

use crate::models::{
    AgentCapabilities, AgentCatalog, AgentKind, AgentModelOption, AgentSkillOption, PermissionMenu,
    PermissionProfileOption, ReasoningEffortOption, SlashCommand,
};

pub fn empty_catalog() -> AgentCatalog {
    let mut catalog = AgentCatalog::empty();
    catalog.capabilities = AgentCapabilities::claude();
    catalog.agent = Some(AgentKind::ClaudeCode);
    catalog
}

/// `SDKControlInitializeResponse`（sdk.d.ts 约 L4588）：commands / models。
/// `reported_model` 来自 `system/init` 或响应里的 `model`。不在列表里就补一行，
/// 让作曲栏能显示 CLI 实际在用的 id，而不是写死的模型表。
pub fn apply_initialize(catalog: &mut AgentCatalog, payload: &Value, reported_model: Option<&str>) {
    if let Some(commands) = payload.get("commands").and_then(Value::as_array) {
        catalog.commands = commands.iter().filter_map(slash_from_value).collect();
    }
    if payload.get("skills").is_some() {
        catalog.skills = payload
            .get("skills")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(skill_from_value).collect())
            .unwrap_or_default();
    }
    if let Some(items) = payload.get("models").and_then(Value::as_array) {
        catalog.models = items
            .iter()
            .filter_map(|item| model_from_value(item, reported_model))
            .collect();
    }
    if let Some(model) = nonempty(reported_model) {
        catalog.cli_config_read = Some(true);
        catalog.thread_model = Some(ensure_listed(catalog, model));
    }
}

/// `list_models` 的成功包。空列表不覆盖 initialize 已经拿到的模型。
pub fn apply_model_list(catalog: &mut AgentCatalog, payload: &Value) {
    let Some(items) = payload
        .as_array()
        .or_else(|| payload.get("models").and_then(Value::as_array))
    else {
        return;
    };
    let current = catalog.thread_model.clone();
    let models: Vec<_> = items
        .iter()
        .filter_map(|item| model_from_value(item, current.as_deref()))
        .collect();
    if models.is_empty() {
        return;
    }
    catalog.models = models;
    if let Some(current) = current.as_deref() {
        catalog.thread_model = Some(ensure_listed(catalog, current));
    }
}

/// `get_settings` 的 `applied.model` / `applied.effort`（`cli/print.ts` `handleGetSettings`）。
/// 失败不能把 `cli_config_read` 写成 false，否则作曲栏会藏起已经知道的线程模型。
pub fn apply_settings(catalog: &mut AgentCatalog, payload: &Value) {
    let applied = payload.get("applied").unwrap_or(payload);
    let effective = payload.get("effective").unwrap_or(&Value::Null);
    if catalog.thread_model.is_none() {
        if let Some(model) = applied
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
        {
            catalog.cli_config_read = Some(true);
            catalog.thread_model = Some(ensure_listed(catalog, model));
        }
    } else if let Some(model) = catalog.thread_model.clone() {
        // 已有线程模型时也做一次别名对齐，避免 resolved 名占位盖住 efforts。
        catalog.thread_model = Some(ensure_listed(catalog, &model));
    }
    let effort = applied
        .get("effort")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .or_else(|| {
            effective
                .get("effortLevel")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
        });
    if let Some(effort) = effort {
        catalog.thread_effort = Some(effort.to_string());
    }
}

/// 把 CLI 报告的模型名对齐到目录条目。
/// `get_settings.applied.model` 常是 `resolvedModel`（如 gpt-6.1-sol），
/// 而 `list_models` 的 id 是别名（opus/sonnet）。对不上时不要塞空 efforts 占位。
pub fn ensure_listed(catalog: &mut AgentCatalog, model_id: &str) -> String {
    let raw = model_id.trim();
    if raw.is_empty() {
        return String::new();
    }
    if let Some(index) = find_model_index(catalog, raw) {
        let id = catalog.models[index].id.clone();
        for model in &mut catalog.models {
            model.is_default = model.id == id;
        }
        return id;
    }
    let needle = strip_model_brackets(raw);
    for model in &mut catalog.models {
        model.is_default = false;
    }
    catalog.models.insert(0, placeholder_model(&needle, true));
    needle
}

fn find_model_index(catalog: &AgentCatalog, raw: &str) -> Option<usize> {
    // 先精确：id → resolvedModel → label，避免 gpt-6.1-sol[1m] 剥括号后误命中 gpt-6.1-sol。
    if let Some(index) = catalog.models.iter().position(|model| model.id == raw) {
        return Some(index);
    }
    if let Some(index) = catalog
        .models
        .iter()
        .position(|model| !model.resolved_model.is_empty() && model.resolved_model == raw)
    {
        return Some(index);
    }
    if let Some(index) = catalog.models.iter().position(|model| model.label == raw) {
        return Some(index);
    }
    let stripped = strip_model_brackets(raw);
    if stripped != raw {
        if let Some(index) = catalog
            .models
            .iter()
            .position(|model| !model.resolved_model.is_empty() && model.resolved_model == stripped)
        {
            return Some(index);
        }
        if let Some(index) = catalog.models.iter().position(|model| model.label == stripped) {
            return Some(index);
        }
        if let Some(index) = catalog.models.iter().position(|model| model.id == stripped) {
            return Some(index);
        }
    }
    None
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

fn model_from_value(value: &Value, current: Option<&str>) -> Option<AgentModelOption> {
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
    let is_default = current.is_some_and(|needle| {
        let needle = needle.trim();
        needle == id
            || needle == label
            || (!resolved_model.is_empty() && needle == resolved_model)
            || {
                let stripped = strip_model_brackets(needle);
                stripped == id
                    || stripped == label
                    || (!resolved_model.is_empty() && stripped == resolved_model)
            }
    });
    Some(AgentModelOption {
        id: id.to_string(),
        label: label.to_string(),
        description,
        is_default,
        show_in_picker: true,
        default_effort: String::new(),
        efforts,
        service_tiers: Vec::new(),
        default_service_tier: None,
        resolved_model,
    })
}

fn effort_from_value(value: &Value) -> Option<ReasoningEffortOption> {
    if let Some(id) = value.as_str().map(str::trim).filter(|level| !level.is_empty()) {
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

fn slash_from_value(value: &Value) -> Option<SlashCommand> {
    let raw = nonempty(value.get("name").and_then(Value::as_str))?;
    let name = if raw.starts_with('/') {
        raw.to_string()
    } else {
        format!("/{raw}")
    };
    let hint = value
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let takes_args = value
        .get("argumentHint")
        .and_then(Value::as_str)
        .map(|hint| !hint.trim().is_empty())
        .unwrap_or(false);
    Some(SlashCommand { name, hint, takes_args })
}

fn skill_from_value(value: &Value) -> Option<AgentSkillOption> {
    let raw = nonempty(value.get("name").and_then(Value::as_str))?;
    let name = raw.trim_start_matches('/').to_string();
    if name.is_empty() {
        return None;
    }
    Some(AgentSkillOption {
        name: name.clone(),
        mention: format!("/{name}"),
        label: name,
        description: value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        path: String::new(),
    })
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|item| !item.is_empty())
}

/// 权限菜单。只列出这一会话能选的档位。`active` 是当前 `permission_mode` 对应的档。
pub fn permission_menu(active: &str) -> PermissionMenu {
    PermissionMenu {
        network_access: false,
        writable_roots: false,
        permission_profiles: false,
        approve_for_me: false,
        title: "权限".into(),
        notice: None,
        presets: vec![
            PermissionProfileOption {
                id: "full".into(),
                label: "跳过权限检查".into(),
                description: String::new(),
                disabled_reason: None,
                caution: true,
                allows_extras: false,
            },
            PermissionProfileOption {
                id: "ask".into(),
                label: "询问批准".into(),
                description: String::new(),
                disabled_reason: None,
                caution: false,
                allows_extras: false,
            },
        ],
        profiles: Vec::new(),
        active: Some(active.to_string()),
    }
}
