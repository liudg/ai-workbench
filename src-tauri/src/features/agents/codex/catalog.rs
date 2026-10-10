//! 模型、技能、斜杠命令目录。斜杠命令表是 Codex 能力目录的一部分，不放在前端全局表里。

use serde_json::{json, Value};

use crate::features::agents::AgentError;
use crate::models::{
    AgentCapabilities, AgentCatalog, AgentModelOption, AgentSkillOption, ReasoningEffortOption,
    SlashCommand,
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
pub(super) fn assemble_catalog(
    models: Vec<AgentModelOption>,
    skills: Result<Vec<AgentSkillOption>, ()>,
    previous_skills: Vec<AgentSkillOption>,
) -> Result<AgentCatalog, ()> {
    let skills = match skills {
        Ok(skills) => skills,
        Err(()) if !models.is_empty() => previous_skills,
        Err(()) => return Err(()),
    };
    Ok(AgentCatalog {
        models,
        skills,
        commands: slash_commands(),
        capabilities: AgentCapabilities::codex(),
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
            Err(_) => Err(()),
        };
        assemble_catalog(models, skills, previous_skills)
            .map_err(|()| AgentError::Runtime("读取技能失败，且没有可用模型".into()))
    }

    pub(super) async fn refresh_skills(&self) -> Result<(), AgentError> {
        let listed = self
            .request("skills/list", json!({ "cwd": self.cwd }))
            .await?;
        *self.skills.lock().unwrap() = parse_skills(&listed);
        Ok(())
    }
}

pub(super) fn slash_help() -> String {
    "可用斜杠命令：\n\
     /permissions [完全访问|询问批准|只读]  切换沙箱和审批\n\
     /status  查看模型、线程、目录和权限\n\
     /diff  查看 git diff --stat\n\
     /review  Code review。Review uncommitted changes or compare against a branch\n\
     /plan  Plan mode。Turn plan mode on；再发一次则 Turn plan mode off。/plan 后的文字会作为请求发出\n\
     /model [模型 id]  指定下一轮模型\n\
     /compact  压缩上下文\n\
     /approve  说明如何处理自动审查拒绝（时间线上点允许或拒绝）\n\
     /init  生成 AGENTS.md\n\
     /new  下一条消息开新线程\n\
     /stop  停止会话\n\
     /mcp [verbose]  查看 MCP 服务器和工具\n\
     /goal [目标|edit|pause|resume|clear]  设置或查看任务目标\n\
     /hooks  列出当前目录的钩子\n\
     /worktree [new]  查看或新建 Git 工作树\n\
     其余 /vim、/theme 等终端命令不会发给模型。"
        .into()
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
            .filter(|text| !text.is_empty())
            .map(str::to_string)
            .or_else(|| efforts.first().map(|effort| effort.id.clone()))
            .unwrap_or_default();
        models.push(AgentModelOption {
            id,
            label,
            description: item
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            is_default: item.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
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
    let Some(list) = value.get("skills").and_then(Value::as_array) else {
        return;
    };
    for skill in list {
        if skill.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let name = skill
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let path = skill
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() || path.is_empty() || out.iter().any(|item| item.path == path) {
            continue;
        }
        let mention = name.rsplit(':').next().unwrap_or(&name).to_string();
        let label = skill
            .pointer("/interface/displayName")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
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
            path,
        });
    }
}

pub(super) fn is_skill_token(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
}

pub(super) fn build_turn_input(text: &str, skills: &[KnownSkill], images: &[String]) -> Value {
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
                    skill.mention.eq_ignore_ascii_case(token) || skill.name.eq_ignore_ascii_case(token)
                }) {
                    elements.push(json!({
                        "byteRange": { "start": start, "end": end },
                        "placeholder": skill.label,
                    }));
                    if !attached.iter().any(|item| item.path == skill.path) {
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
    if !text.is_empty() || images.is_empty() {
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
    Value::Array(input)
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

pub(super) fn slash_commands() -> Vec<SlashCommand> {
    vec![
        SlashCommand { name: "/permissions".into(), hint: "切换完全访问、询问批准或只读".into(), takes_args: true },
        SlashCommand { name: "/status".into(), hint: "查看模型、线程、目录和权限".into(), takes_args: false },
        SlashCommand { name: "/diff".into(), hint: "查看 git diff --stat".into(), takes_args: false },
        SlashCommand { name: "/review".into(), hint: "Review uncommitted changes or compare against a branch".into(), takes_args: true },
        SlashCommand { name: "/plan".into(), hint: "Turn plan mode on".into(), takes_args: true },
        SlashCommand { name: "/model".into(), hint: "指定下一轮使用的模型".into(), takes_args: true },
        SlashCommand { name: "/compact".into(), hint: "压缩当前线程的上下文".into(), takes_args: false },
        SlashCommand { name: "/approve".into(), hint: "说明如何处理自动审查拒绝".into(), takes_args: false },
        SlashCommand { name: "/init".into(), hint: "生成 AGENTS.md".into(), takes_args: false },
        SlashCommand { name: "/new".into(), hint: "下一条消息开启新线程".into(), takes_args: false },
        SlashCommand { name: "/clear".into(), hint: "放下当前线程，同 /new".into(), takes_args: false },
        SlashCommand { name: "/stop".into(), hint: "停止当前会话".into(), takes_args: false },
        SlashCommand { name: "/mcp".into(), hint: "查看已连接的 MCP 服务器和工具".into(), takes_args: true },
        SlashCommand { name: "/goal".into(), hint: "设置、查看、暂停或清除任务目标".into(), takes_args: true },
        SlashCommand { name: "/hooks".into(), hint: "列出当前目录发现的钩子".into(), takes_args: false },
        SlashCommand { name: "/worktree".into(), hint: "查看或新建一个独立 Git 工作树".into(), takes_args: true },
        SlashCommand { name: "/help".into(), hint: "列出工作台能执行的斜杠命令".into(), takes_args: false },
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
        let input = build_turn_input("请用 $documents 改合同", &skills, &[]);
        assert_eq!(input[1]["type"], json!("skill"));
        assert_eq!(input[1]["name"], json!("documents:documents"));
        assert_eq!(input[0]["text_elements"][0]["placeholder"], json!("Documents"));
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
        let catalog = assemble_catalog(models, Err(()), previous).expect("models stay");
        assert_eq!(catalog.models[0].id, "gpt-cached");
        assert_eq!(catalog.skills[0].mention, "documents");
    }

    #[test]
    fn skills_failure_without_models_is_an_error() {
        assert!(assemble_catalog(Vec::new(), Err(()), Vec::new()).is_err());
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
    fn splits_slash_args() {
        assert_eq!(
            split_command("/permissions 只读"),
            ("permissions".into(), "只读".into())
        );
    }
}
