//! Codex 桌面端已经在用的 review / plan / diff。
//! 这里只组协议参数和解析官方文本，不另写一套给模型的提示。

use serde_json::{json, Value};

use aiwb_core::models::{PlanStep, ReviewFinding, ReviewStart, SessionEventBody};

mod git;
mod modes;

#[cfg(test)]
mod tests;

pub(in crate::codex) use git::git_review_targets;

pub(super) fn review_protocol(target: &ReviewStart) -> Value {
    match target {
        ReviewStart::Uncommitted => json!({ "type": "uncommittedChanges" }),
        ReviewStart::Base { branch } => json!({ "type": "baseBranch", "branch": branch }),
        ReviewStart::Commit { sha, title } => {
            let mut value = json!({ "type": "commit", "sha": sha });
            if !title.trim().is_empty() {
                value["title"] = json!(title.trim());
            }
            value
        }
        ReviewStart::Custom { instructions } => {
            json!({ "type": "custom", "instructions": instructions })
        }
    }
}

/// `exitedReviewMode.review` 是官方渲染后的字符串，不是结构化 JSON。
pub(super) fn parse_review_output(raw: &str) -> SessionEventBody {
    let raw_trimmed = raw.trim();
    let (summary, findings) = split_findings(raw_trimmed);
    SessionEventBody::ReviewFindings {
        summary,
        findings,
        raw: raw_trimmed.to_string(),
    }
}

fn split_findings(raw: &str) -> (String, Vec<ReviewFinding>) {
    if raw.is_empty() {
        return (String::new(), Vec::new());
    }
    let lines: Vec<&str> = raw.lines().collect();
    let marker = lines.iter().position(|line| {
        let trimmed = line.trim();
        trimmed == "Review comment:" || trimmed == "Full review comments:"
    });
    let Some(marker) = marker else {
        return (raw.to_string(), Vec::new());
    };
    let summary = lines[..marker].join("\n").trim().to_string();
    let mut findings = Vec::new();
    let mut current: Option<ReviewFinding> = None;
    for line in lines.iter().skip(marker + 1) {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("- ") {
            if let Some(done) = current.take() {
                findings.push(done);
            }
            let (title, location) = split_title_location(rest);
            current = Some(ReviewFinding {
                title,
                location,
                body: String::new(),
            });
            continue;
        }
        if trimmed.is_empty() {
            continue;
        }
        if let Some(item) = current.as_mut() {
            if !item.body.is_empty() {
                item.body.push('\n');
            }
            item.body.push_str(trimmed);
        }
    }
    if let Some(done) = current {
        findings.push(done);
    }
    let summary = if summary.is_empty() {
        raw.to_string()
    } else {
        summary
    };
    (summary, findings)
}

fn split_title_location(rest: &str) -> (String, String) {
    if let Some((title, location)) = rest.split_once('\u{2014}') {
        return (title.trim().to_string(), location.trim().to_string());
    }
    if let Some((title, location)) = rest.split_once(" -- ") {
        return (title.trim().to_string(), location.trim().to_string());
    }
    (rest.trim().to_string(), String::new())
}

/// 实验接口 `turn/start.collaborationMode`。`developer_instructions: null` 用内置说明。
/// 退出计划时也要显式带 `default`，否则线程会沿用上一回合的计划模式。
pub(super) fn collaboration_mode_value(mode: &str, model: &str, effort: Option<&str>) -> Value {
    json!({
        "mode": mode,
        "settings": {
            "model": model,
            "reasoning_effort": effort,
            "developer_instructions": Value::Null,
        }
    })
}

/// 作曲栏选过的强度优先；否则用线程回包里的生效强度（配置里的默认值）。
pub(super) fn pick_effort(selected: Option<String>, thread: Option<String>) -> Option<String> {
    selected
        .filter(|e| !e.trim().is_empty())
        .or(thread.filter(|e| !e.trim().is_empty()))
}

pub(super) fn plan_collaboration_mode(model: &str, effort: Option<&str>) -> Value {
    collaboration_mode_value("plan", model, effort)
}

pub(super) fn plan_steps_event(params: &Value) -> Option<SessionEventBody> {
    let turn_id = params
        .get("turnId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if turn_id.is_empty() {
        return None;
    }
    let explanation = params
        .get("explanation")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let steps = params
        .get("plan")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let step = item.get("step").and_then(Value::as_str)?.trim();
                    if step.is_empty() {
                        return None;
                    }
                    let status = item
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("pending")
                        .to_string();
                    Some(PlanStep {
                        step: step.to_string(),
                        status,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(SessionEventBody::PlanSteps {
        turn_id: turn_id.to_string(),
        explanation,
        steps,
        mode: Some("plan".into()),
    })
}
