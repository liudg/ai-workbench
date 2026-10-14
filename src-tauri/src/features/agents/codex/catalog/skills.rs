//! `skills/list` 的解析，以及哪些技能路径可以附到回合里。

use serde_json::Value;

use super::super::state::KnownSkill;

pub(in crate::features::agents::codex) fn parse_skills(value: &Value) -> Vec<KnownSkill> {
    let mut skills = Vec::new();
    collect_skills(value, &mut skills);
    skills
}

pub(in crate::features::agents::codex) fn collect_skills(value: &Value, out: &mut Vec<KnownSkill>) {
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

pub(in crate::features::agents::codex) fn attachable_skill_path(path: &str) -> bool {
    let path = path.trim();
    if path.is_empty() || path.starts_with("name:") {
        return false;
    }
    path.contains('/') || path.contains('\\') || path.to_ascii_lowercase().ends_with(".md")
}

pub(in crate::features::agents::codex) fn is_skill_token(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
}
