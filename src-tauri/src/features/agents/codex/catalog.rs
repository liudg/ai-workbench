//! 模型、技能、斜杠命令目录。斜杠命令表是 Codex 能力目录的一部分，不放在前端全局表里。

use serde_json::{json, Value};

use crate::features::agents::AgentError;
use crate::models::{
    AgentCapabilities, AgentCatalog, AgentModelOption, AgentSkillOption, PageAnnotation,
    ReasoningEffortOption, SlashCommand,
};

use super::state::{KnownSkill, Shared};

fn skill_options(skills: &[KnownSkill]) -> Vec<AgentSkillOption> {
    skills
        .iter()
        .map(|skill| AgentSkillOption {
            name: skill.name.clone(),
            mention: skill.mention.clone(),
            label: skill.label.clone(),
            description: skill.description.clone(),
            path: skill.path.clone(),
        })
        .collect()
}

/// 技能请求失败时保留已有技能，但只要模型列表非空就仍然返回模型。
/// 没有可保留的技能时带上失败原因，避免作曲栏把失败说成「没有技能」。
pub(super) fn assemble_catalog(
    models: Vec<AgentModelOption>,
    skills: Result<Vec<AgentSkillOption>, String>,
    previous_skills: Vec<AgentSkillOption>,
) -> Result<AgentCatalog, ()> {
    let (skills, skills_error) = match skills {
        Ok(skills) => (skills, None),
        Err(_) if !models.is_empty() && !previous_skills.is_empty() => (previous_skills, None),
        Err(message) if !models.is_empty() => (previous_skills, Some(message)),
        Err(_) => return Err(()),
    };
    Ok(AgentCatalog {
        models,
        skills,
        commands: slash_commands(),
        capabilities: AgentCapabilities::codex(),
        skills_error,
        configured_model: None,
        configured_effort: None,
        thread_model: None,
        thread_effort: None,
        cli_config_read: None,
    })
}

/// `skills/list` 的官方参数。`cwds` 为空时服务端用会话工作目录；这里显式带上项目目录。
/// `forceReload` 跳过按目录缓存的结果，避免刚装上的技能被说成没有。
pub(super) fn skills_list_params(cwd: &str) -> Value {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return json!({ "forceReload": true });
    }
    json!({
        "cwds": [cwd],
        "forceReload": true,
    })
}

impl Shared {
    pub(super) fn set_tuning(&self, model: Option<String>, effort: Option<String>) {
        if let Some(model) = model {
            let trimmed = model.trim();
            *self.model_override.lock().unwrap() = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            };
        }
        if let Some(effort) = effort {
            let trimmed = effort.trim();
            *self.effort.lock().unwrap() = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            };
        }
    }

    pub(super) async fn catalog(&self) -> Result<AgentCatalog, AgentError> {
        let _ = self.refresh_sandbox_features().await;
        let models = match self
            .request("model/list", json!({ "includeHidden": true }))
            .await
        {
            Ok(value) => parse_models(&value),
            Err(err) => return Err(err),
        };
        let previous_skills = skill_options(&self.skills.lock().unwrap());
        let skills = match self.refresh_skills().await {
            Ok(()) => Ok(skill_options(&self.skills.lock().unwrap())),
            Err(err) => Err(err.to_string()),
        };
        let mut catalog = assemble_catalog(models, skills, previous_skills)
            .map_err(|()| AgentError::Runtime("读取技能失败，且没有可用模型".into()))?;
        apply_cli_defaults(self, &mut catalog).await;
        Ok(catalog)
    }

    pub(super) async fn refresh_skills(&self) -> Result<(), AgentError> {
        let listed = self
            .request("skills/list", skills_list_params(&self.cwd))
            .await?;
        *self.skills.lock().unwrap() = parse_skills(&listed);
        Ok(())
    }
}

/// 工作台自己的 `/help`（TUI 没有这条命令）：列出这里能执行的斜杠命令。
pub(super) fn slash_help() -> String {
    let mut lines = vec!["可用斜杠命令（说明取自 Codex TUI）：".to_string()];
    for command in slash_commands() {
        lines.push(format!("{}  {}", command.name, command.hint));
    }
    lines.push("其余 TUI 命令（/vim、/theme 等）工作台不执行，也不会发给模型。".into());
    lines.join("\n")
}

/// `config/read` 的有效配置。外层可能是 `{ config: {...} }`，字段是 snake_case。
pub(super) struct CliModelConfig {
    pub model: Option<String>,
    pub effort: Option<String>,
}

pub(super) fn parse_cli_model_config(value: &Value) -> CliModelConfig {
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

async fn apply_cli_defaults(shared: &Shared, catalog: &mut AgentCatalog) {
    match shared.request("config/read", json!({})).await {
        Ok(value) => {
            let parsed = parse_cli_model_config(&value);
            catalog.configured_model = parsed.model;
            catalog.configured_effort = parsed.effort;
            catalog.cli_config_read = Some(true);
        }
        Err(_) => {
            catalog.cli_config_read = Some(false);
        }
    }
    let thread_model = shared.model.lock().unwrap().clone();
    let thread_model = thread_model.trim();
    if !thread_model.is_empty() {
        catalog.thread_model = Some(thread_model.to_string());
    }
    catalog.thread_effort = shared
        .thread_effort
        .lock()
        .unwrap()
        .clone()
        .filter(|effort| !effort.trim().is_empty());
}

pub(super) fn parse_models(value: &Value) -> Vec<AgentModelOption> {
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

pub(super) fn parse_skills(value: &Value) -> Vec<KnownSkill> {
    let mut skills = Vec::new();
    collect_skills(value, &mut skills);
    skills
}

pub(super) fn collect_skills(value: &Value, out: &mut Vec<KnownSkill>) {
    if let Some(list) = value.as_array() {
        for item in list {
            collect_skills(item, out);
        }
        return;
    }
    // 官方响应是 `{ "data": [{ "cwd", "skills": [...] }] }`，不是顶层 `skills`。
    if let Some(entries) = value.get("data").and_then(Value::as_array) {
        for entry in entries {
            collect_skills(entry, out);
        }
    }
    if let Some(list) = value.get("skills").and_then(Value::as_array) {
        for skill in list {
            push_skill(skill, out);
        }
        return;
    }
    push_skill(value, out);
}

fn push_skill(skill: &Value, out: &mut Vec<KnownSkill>) {
    if skill.get("enabled").and_then(Value::as_bool) == Some(false) {
        return;
    }
    let name = skill
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        return;
    }
    let path = skill_path(skill);
    let identity = if path.is_empty() {
        format!("name:{name}")
    } else {
        path.clone()
    };
    if out.iter().any(|item| item.path == identity) {
        return;
    }
    let mention = name.rsplit(':').next().unwrap_or(&name).to_string();
    let label = skill
        .pointer("/interface/displayName")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .or_else(|| {
            skill
                .get("displayName")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
        })
        .unwrap_or(&mention)
        .to_string();
    out.push(KnownSkill {
        description: skill
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        name,
        mention,
        label,
        path: identity,
    });
}

/// 协议字段是 `path`。没有路径时仍保留技能，提交时只写 `$name`，不编造文件路径。
fn skill_path(skill: &Value) -> String {
    for key in ["path", "pathToSkillsMd", "skillPath"] {
        if let Some(path) = skill.get(key).and_then(Value::as_str) {
            let path = path.trim();
            if !path.is_empty() {
                return path.to_string();
            }
        }
    }
    String::new()
}

pub(super) fn attachable_skill_path(path: &str) -> bool {
    let path = path.trim();
    if path.is_empty() || path.starts_with("name:") {
        return false;
    }
    path.contains('/') || path.contains('\\') || path.to_ascii_lowercase().ends_with(".md")
}

pub(super) fn is_skill_token(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
}

pub(super) fn build_turn_input(
    text: &str,
    skills: &[KnownSkill],
    images: &[String],
    annotations: &[PageAnnotation],
) -> Value {
    let bytes = text.as_bytes();
    let mut elements = Vec::new();
    let mut attached: Vec<&KnownSkill> = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'$' {
            let start = index;
            let mut end = index + 1;
            while end < bytes.len() && is_skill_token(bytes[end]) {
                end += 1;
            }
            let token = &text[index + 1..end];
            if !token.is_empty() {
                if let Some(skill) = skills.iter().find(|skill| {
                    skill.mention.eq_ignore_ascii_case(token)
                        || skill.name.eq_ignore_ascii_case(token)
                }) {
                    elements.push(json!({
                        "byteRange": { "start": start, "end": end },
                        "placeholder": skill.label,
                    }));
                    if attachable_skill_path(&skill.path)
                        && !attached.iter().any(|item| item.path == skill.path)
                    {
                        attached.push(skill);
                    }
                }
            }
            index = end;
            continue;
        }
        index += 1;
    }
    let mut input = Vec::new();
    if !text.is_empty() || (images.is_empty() && annotations.is_empty()) {
        let mut text_item = json!({ "type": "text", "text": text });
        if !elements.is_empty() {
            text_item["text_elements"] = Value::Array(elements);
        }
        input.push(text_item);
    }
    for skill in attached {
        input.push(json!({
            "type": "skill",
            "name": skill.name,
            "path": skill.path,
        }));
    }
    for image in images {
        input.push(image_input_item(image));
    }
    for note in annotations {
        push_comment_attachment(&mut input, note, images);
    }
    Value::Array(input)
}

/// Codex 注释附件：评论文本单独成一条，截图走 localImage，不折进通用中文模板。
fn push_comment_attachment(input: &mut Vec<Value>, note: &PageAnnotation, images: &[String]) {
    let comment = comment_attachment_text(note);
    if !comment.is_empty() {
        input.push(json!({ "type": "text", "text": comment }));
    }
    if let Some(path) = note
        .screenshot
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        if !images.iter().any(|image| image == path) {
            input.push(image_input_item(path));
        }
    }
}

fn comment_attachment_text(note: &PageAnnotation) -> String {
    let comment = note.comment.trim();
    if !comment.is_empty() {
        return comment.to_string();
    }
    let selector = note.selector.trim();
    let url = note.url.trim();
    match (selector.is_empty(), url.is_empty()) {
        (false, false) => format!("{selector} {url}"),
        (false, true) => selector.to_string(),
        (true, false) => url.to_string(),
        (true, true) => String::new(),
    }
}

fn image_input_item(raw: &str) -> Value {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("data:") || lower.starts_with("https://") || lower.starts_with("http://") {
        json!({ "type": "image", "url": trimmed })
    } else {
        json!({ "type": "localImage", "path": trimmed })
    }
}

pub(super) fn split_command(text: &str) -> (String, String) {
    let body = text.trim().trim_start_matches('/');
    let mut parts = body.splitn(2, char::is_whitespace);
    let name = parts.next().unwrap_or("").to_ascii_lowercase();
    let rest = parts.next().unwrap_or("").trim().to_string();
    (name, rest)
}

/// 斜杠命令表。说明逐字取自 Codex TUI `slash_command.rs::description`；`/help` 是工作台自己的。
pub(super) fn slash_commands() -> Vec<SlashCommand> {
    vec![
        SlashCommand {
            name: "/permissions".into(),
            hint: "choose what Codex is allowed to do".into(),
            takes_args: true,
        },
        SlashCommand {
            name: "/status".into(),
            hint: "show current session configuration and token usage".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/diff".into(),
            hint: "show git diff (including untracked files)".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/review".into(),
            hint: "review my current changes and find issues".into(),
            takes_args: true,
        },
        SlashCommand {
            name: "/plan".into(),
            hint: "switch to Plan mode".into(),
            takes_args: true,
        },
        SlashCommand {
            name: "/model".into(),
            hint: "choose what model and reasoning effort to use".into(),
            takes_args: true,
        },
        SlashCommand {
            name: "/compact".into(),
            hint: "summarize conversation to prevent hitting the context limit".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/approve".into(),
            hint: "approve one retry of a recent auto-review denial".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/init".into(),
            hint: "create an AGENTS.md file with instructions for Codex".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/new".into(),
            hint: "start a new chat during a conversation".into(),
            takes_args: true,
        },
        SlashCommand {
            name: "/clear".into(),
            hint: "clear the terminal and start a new chat".into(),
            takes_args: true,
        },
        SlashCommand {
            name: "/stop".into(),
            hint: "stop all background terminals".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/quit".into(),
            hint: "exit Codex".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/mcp".into(),
            hint: "list MCP tools; use /mcp verbose or /mcp login <name>".into(),
            takes_args: true,
        },
        SlashCommand {
            name: "/goal".into(),
            hint: "set or view the goal for a long-running task".into(),
            takes_args: true,
        },
        SlashCommand {
            name: "/hooks".into(),
            hint: "view and manage lifecycle hooks".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/worktree".into(),
            hint: "start or continue a conversation in a new worktree".into(),
            takes_args: false,
        },
        SlashCommand {
            name: "/help".into(),
            hint: "列出工作台能执行的斜杠命令".into(),
            takes_args: false,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attaches_skill_mentions() {
        let skills = vec![KnownSkill {
            name: "documents:documents".into(),
            mention: "documents".into(),
            label: "Documents".into(),
            description: String::new(),
            path: "C:/skills/documents/SKILL.md".into(),
        }];
        let input = build_turn_input("请用 $documents 改合同", &skills, &[], &[]);
        assert_eq!(input[1]["type"], json!("skill"));
        assert_eq!(input[1]["name"], json!("documents:documents"));
        assert_eq!(
            input[0]["text_elements"][0]["placeholder"],
            json!("Documents")
        );
    }

    #[test]
    fn images_are_input_items_not_filenames() {
        let input = build_turn_input(
            "",
            &[],
            &[
                "C:/shot.png".into(),
                "data:image/png;base64,aaaa".into(),
                "https://example.com/a.png".into(),
            ],
            &[],
        );
        let items = input.as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["type"], json!("localImage"));
        assert_eq!(items[0]["path"], json!("C:/shot.png"));
        assert_eq!(items[1]["type"], json!("image"));
        assert_eq!(items[1]["url"], json!("data:image/png;base64,aaaa"));
        assert_eq!(items[2]["url"], json!("https://example.com/a.png"));
    }

    #[test]
    fn skills_failure_keeps_models_and_previous_skills() {
        let models = vec![AgentModelOption {
            id: "gpt-cached".into(),
            label: "GPT Cached".into(),
            description: String::new(),
            is_default: true,
            default_effort: "medium".into(),
            efforts: Vec::new(),
        }];
        let previous = vec![AgentSkillOption {
            name: "documents:documents".into(),
            mention: "documents".into(),
            label: "Documents".into(),
            description: String::new(),
            path: "C:/skills/documents/SKILL.md".into(),
        }];
        let catalog =
            assemble_catalog(models, Err("读取技能失败".into()), previous).expect("models stay");
        assert_eq!(catalog.models[0].id, "gpt-cached");
        assert_eq!(catalog.skills[0].mention, "documents");
        assert!(catalog.skills_error.is_none());
    }

    #[test]
    fn skills_failure_without_a_previous_list_is_reported() {
        let models = vec![AgentModelOption {
            id: "gpt-cached".into(),
            label: "GPT Cached".into(),
            description: String::new(),
            is_default: true,
            default_effort: "medium".into(),
            efforts: Vec::new(),
        }];
        let catalog = assemble_catalog(
            models,
            Err("等待 Codex skills/list 超时".into()),
            Vec::new(),
        )
        .expect("models stay");
        assert!(catalog.skills.is_empty());
        assert_eq!(
            catalog.skills_error.as_deref(),
            Some("等待 Codex skills/list 超时")
        );
    }

    #[test]
    fn skills_failure_without_models_is_an_error() {
        assert!(assemble_catalog(Vec::new(), Err("读取技能失败".into()), Vec::new()).is_err());
    }

    #[test]
    fn skills_list_params_use_cwds_and_force_reload() {
        let params = skills_list_params("/work/app");
        assert_eq!(params["cwds"][0], json!("/work/app"));
        assert_eq!(params["forceReload"], json!(true));
        assert!(params.get("cwd").is_none());
        assert_eq!(skills_list_params("  ")["forceReload"], json!(true));
    }

    #[test]
    fn parses_official_skills_list_data_wrapper() {
        let listed = json!({
            "data": [{
                "cwd": "/work/app",
                "skills": [
                    {
                        "name": "skill-creator",
                        "description": "Create or update a Codex skill",
                        "enabled": true,
                        "interface": { "displayName": "Skill Creator" },
                        "path": "/Users/me/.codex/skills/skill-creator/SKILL.md"
                    },
                    {
                        "name": "hidden-skill",
                        "description": "off",
                        "enabled": false,
                        "path": "/Users/me/.codex/skills/hidden/SKILL.md"
                    }
                ],
                "errors": []
            }]
        });
        let skills = parse_skills(&listed);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].mention, "skill-creator");
        assert_eq!(skills[0].label, "Skill Creator");
        assert!(attachable_skill_path(&skills[0].path));
    }

    #[test]
    fn skill_without_path_stays_listed_but_is_not_attached_as_a_file() {
        let listed = json!({
            "data": [{
                "skills": [{
                    "name": "documents:documents",
                    "description": "Docs",
                    "interface": { "displayName": "Documents" }
                }]
            }]
        });
        let skills = parse_skills(&listed);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].mention, "documents");
        assert_eq!(skills[0].label, "Documents");
        assert!(!attachable_skill_path(&skills[0].path));
        let input = build_turn_input("用 $documents", &skills, &[], &[]);
        assert_eq!(input.as_array().unwrap().len(), 1);
        assert_eq!(
            input[0]["text_elements"][0]["placeholder"],
            json!("Documents")
        );
    }

    #[test]
    fn cli_config_model_ignores_the_catalog_default() {
        let wrapped = parse_cli_model_config(&json!({
            "config": {
                "model": "gpt-5.4",
                "modelReasoningEffort": null,
                "model_reasoning_effort": "high",
            }
        }));
        assert_eq!(wrapped.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(wrapped.effort.as_deref(), Some("high"));
        let bare = parse_cli_model_config(&json!({ "model": "gpt-5.4" }));
        assert_eq!(bare.model.as_deref(), Some("gpt-5.4"));
        assert!(bare.effort.is_none());
        let unset = parse_cli_model_config(&json!({
            "config": { "model": "  ", "model_reasoning_effort": "" }
        }));
        assert!(unset.model.is_none());
        assert!(unset.effort.is_none());
    }

    #[test]
    fn missing_default_effort_is_not_the_first_supported_effort() {
        let models = parse_models(&json!({
            "data": [{
                "model": "gpt-test",
                "displayName": "GPT Test",
                "supportedReasoningEfforts": [
                    { "reasoningEffort": "low", "description": "fast" }
                ]
            }]
        }));
        assert_eq!(models[0].default_effort, "");
    }

    #[test]
    fn reads_model_efforts() {
        let models = parse_models(&json!({
            "data": [{
                "model": "gpt-test",
                "displayName": "GPT Test",
                "hidden": false,
                "isDefault": true,
                "defaultReasoningEffort": "medium",
                "supportedReasoningEfforts": [
                    { "reasoningEffort": "low", "description": "fast" },
                    { "reasoningEffort": "medium", "description": "balanced" }
                ]
            }]
        }));
        assert_eq!(models[0].id, "gpt-test");
        assert_eq!(models[0].efforts.len(), 2);
        assert_eq!(models[0].default_effort, "medium");
    }

    #[test]
    fn page_annotation_is_a_comment_item_and_local_image() {
        let note = PageAnnotation {
            id: "n1".into(),
            url: "https://example.com/page".into(),
            selector: "button.save".into(),
            text: "保存".into(),
            comment: "看这里".into(),
            x: 1,
            y: 2,
            width: 3,
            height: 4,
            kind: "element".into(),
            screenshot: Some("C:/shot.png".into()),
            snapshot_failed: false,
        };
        let input = build_turn_input("", &[], &[], &[note]);
        let items = input.as_array().expect("input items");
        assert!(items
            .iter()
            .any(|item| { item["type"] == json!("text") && item["text"] == json!("看这里") }));
        assert!(items.iter().any(|item| {
            item["type"] == json!("localImage") && item["path"] == json!("C:/shot.png")
        }));
        assert!(!input.to_string().contains("页面批注"));
    }

    #[test]
    fn splits_slash_args() {
        assert_eq!(
            split_command("/permissions 只读"),
            ("permissions".into(), "只读".into())
        );
    }
}
