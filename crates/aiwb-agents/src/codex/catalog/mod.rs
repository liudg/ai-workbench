//! 模型、技能、斜杠命令目录。斜杠命令表是 Codex 能力目录的一部分，不放在前端全局表里。

use serde_json::{json, Value};

use crate::AgentError;
use aiwb_core::models::{AgentCapabilities, AgentCatalog, AgentKind, AgentModelOption, AgentSkillOption};

use super::state::{KnownSkill, Shared};

mod input;
mod models;
mod skills;

#[cfg(test)]
mod tests;

pub(in crate::codex) use input::{
    build_turn_input, slash_commands, split_command,
};
pub(in crate::codex) use models::{parse_cli_model_config, parse_models};
pub(in crate::codex) use skills::parse_skills;

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
        configured_service_tier: None,
        thread_model: None,
        thread_effort: None,
        cli_config_read: None,
        agent: Some(AgentKind::CodexCli),
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

    /// `None` 或空字符串都是显式关掉速度档，下一回合会带 `serviceTier: null`。
    /// 还没调过这个方法时不写字段，让 CLI 自己的配置生效。
    pub(super) fn set_service_tier(&self, tier: Option<String>) {
        let stored = match tier {
            Some(value) => {
                let trimmed = value.trim();
                if trimmed.is_empty() || trimmed == "default" {
                    Some(String::new())
                } else {
                    Some(trimmed.to_string())
                }
            }
            None => Some(String::new()),
        };
        *self.service_tier.lock().unwrap() = stored;
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

async fn apply_cli_defaults(shared: &Shared, catalog: &mut AgentCatalog) {
    match shared.request("config/read", json!({})).await {
        Ok(value) => {
            let parsed = parse_cli_model_config(&value);
            catalog.configured_model = parsed.model;
            catalog.configured_effort = parsed.effort;
            catalog.configured_service_tier = parsed.service_tier;
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
