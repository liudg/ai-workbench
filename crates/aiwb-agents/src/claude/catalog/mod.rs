//! initialize / list_models / get_settings 的目录。只写入 CLI 报告的字段。
//!
//! `ModelInfo` 用 `value` / `displayName` / `description` / `supportedEffortLevels`
//! （官方 SDK `sdk.d.ts` 约 L1396）。斜杠命令的 `argumentHint` 非空才算带参数
//! （`SlashCommand` 约 L9431）。`skills` 字段缺失时不把命令复制成技能。
//! 模型名对齐在 `models`。权限菜单不在这里。

use serde_json::Value;

use aiwb_core::models::{AgentCapabilities, AgentCatalog, AgentKind, AgentSkillOption, SlashCommand};

mod models;

pub(in crate::claude) use models::adopt_thread_model;

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
        catalog.models = items.iter().filter_map(models::model_from_value).collect();
    }
    if let Some(model) = nonempty(reported_model) {
        adopt_thread_model(catalog, model);
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
    let models: Vec<_> = items.iter().filter_map(models::model_from_value).collect();
    if models.is_empty() {
        return;
    }
    catalog.models = models;
    if let Some(current) = current.as_deref() {
        catalog.thread_model = Some(models::ensure_listed(catalog, current));
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
            adopt_thread_model(catalog, model);
        }
    } else {
        // 已有线程模型时也做一次别名对齐，避免 resolved 名占位盖住 efforts。
        models::align_thread_model(catalog);
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
    Some(SlashCommand {
        name,
        hint,
        takes_args,
    })
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
