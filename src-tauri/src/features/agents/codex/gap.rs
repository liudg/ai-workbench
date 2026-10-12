//! Codex 桌面端已经在用的 review / plan / diff。
//! 这里只组协议参数和解析官方文本，不另写一套给模型的提示。

use std::process::Stdio;

use serde_json::{json, Value};
use tokio::process::Command;

use crate::encoding::decode_child_bytes;
use crate::features::agents::AgentError;
use crate::models::{
    PlanStep, PromptKind, PromptOption, ReviewFinding, ReviewLabels, ReviewStart, ReviewTargets,
    SessionEventBody,
};

use super::process::hide_console;
use super::state::{emit, Collaboration, Pending, Shared};

/// TUI `chatwidget/plan_implementation.rs` 的标题、选项和消息。
pub(super) const PLAN_IMPLEMENTATION_TITLE: &str = "Implement this plan?";
const PLAN_IMPLEMENTATION_YES: &str = "Yes, implement this plan";
const PLAN_IMPLEMENTATION_CLEAR_CONTEXT: &str = "Yes, clear context and implement";
const PLAN_IMPLEMENTATION_NO: &str = "No, stay in Plan mode";
pub(super) const PLAN_IMPLEMENTATION_CODING_MESSAGE: &str = "Implement the plan.";
pub(super) const PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX: &str = concat!(
    "A previous agent produced the plan below to accomplish the user's task. ",
    "Implement the plan in a fresh context. Treat the plan as the source of ",
    "user intent, re-read files as needed, and carry the work through ",
    "implementation and verification."
);
const PLAN_IMPLEMENTATION_NO_APPROVED_PLAN: &str = "No approved plan available";
const IMPLEMENT_ID: &str = "implement";
const CLEAR_CONTEXT_ID: &str = "clear-context";
const STAY_ID: &str = "stay";

/// 三个选项。清空上下文那项在没有计划正文时不可选。
pub(super) fn plan_implementation_options(
    plan_markdown: Option<&str>,
    usage_label: Option<&str>,
) -> Vec<PromptOption> {
    let has_plan = plan_markdown.is_some_and(|plan| !plan.trim().is_empty());
    vec![
        PromptOption {
            id: IMPLEMENT_ID.into(),
            label: PLAN_IMPLEMENTATION_YES.into(),
            description: "Switch to Default and start coding".into(),
            ..Default::default()
        },
        PromptOption {
            id: CLEAR_CONTEXT_ID.into(),
            label: PLAN_IMPLEMENTATION_CLEAR_CONTEXT.into(),
            description: usage_label.map_or_else(
                || "Fresh thread with this plan".to_string(),
                |label| format!("Start a fresh thread (current context: {label})"),
            ),
            disabled_reason: (!has_plan).then(|| PLAN_IMPLEMENTATION_NO_APPROVED_PLAN.into()),
        },
        PromptOption {
            id: STAY_ID.into(),
            label: PLAN_IMPLEMENTATION_NO.into(),
            description: "Continue planning with the model".into(),
            ..Default::default()
        },
    ]
}

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

/// `review_popups.rs` 的标题和选项。
pub(super) fn review_labels(current_branch: Option<&str>) -> ReviewLabels {
    ReviewLabels {
        title: "Select a review preset".into(),
        base_branch: "Review against a base branch".into(),
        base_branch_hint: "(PR Style)".into(),
        uncommitted: "Review uncommitted changes".into(),
        commit: "Review a commit".into(),
        custom: "Custom review instructions".into(),
        branch_title: "Select a base branch".into(),
        branch_subtitle: format!(
            "Current branch: {}",
            current_branch.unwrap_or("(detached HEAD)")
        ),
        branch_search: "Type to search branches".into(),
        commit_title: "Select a commit to review".into(),
        commit_search: "Type to search commits".into(),
        custom_placeholder: "Type instructions and press Enter".into(),
    }
}

/// `git-utils/src/info.rs` 的 `local_git_branches`、`current_branch_name`、`recent_commits(100)`。
/// 官方在出错时返回空列表，不报错。
pub(super) async fn git_review_targets(cwd: &str) -> ReviewTargets {
    let mut branches: Vec<String> = git(cwd, &["for-each-ref", "--format=%(refname:short)", "refs/heads"])
        .await
        .map(|text| {
            text.lines()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    branches.sort_unstable();
    for candidate in ["main", "master"] {
        let refname = format!("refs/heads/{candidate}");
        if git(cwd, &["rev-parse", "--verify", "--quiet", &refname]).await.is_ok() {
            if let Some(pos) = branches.iter().position(|name| name == candidate) {
                let base = branches.remove(pos);
                branches.insert(0, base);
            }
            break;
        }
    }
    let current_branch = git(cwd, &["branch", "--show-current"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|name| !name.is_empty());
    let commits = if git(cwd, &["rev-parse", "--git-dir"]).await.is_ok() {
        git(cwd, &["log", "-n", "100", "--pretty=format:%H%x1f%ct%x1f%s"])
            .await
            .map(|text| parse_commit_log(&text))
            .unwrap_or_default()
        } else {
        Vec::new()
    };
    ReviewTargets {
        branches,
        commits,
        error: None,
        labels: review_labels(current_branch.as_deref()),
        current_branch,
    }
}

fn parse_commit_log(text: &str) -> Vec<crate::models::ReviewCommit> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split('\u{001f}');
            let sha = parts.next().unwrap_or("").trim();
            let ts = parts.next().unwrap_or("").trim();
            let subject = parts.next().unwrap_or("").trim();
            if sha.is_empty() || ts.is_empty() {
                return None;
            }
            Some(crate::models::ReviewCommit {
                sha: sha.to_string(),
                title: subject.to_string(),
            })
        })
        .collect()
}

async fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg("core.hooksPath=".to_string() + if cfg!(windows) { "NUL" } else { "/dev/null" })
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_console(&mut command);
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
        .await
        .map_err(|_| "git timed out".to_string())?
        .map_err(|err| err.to_string())?;
    if output.status.success() {
        return Ok(decode_child_bytes(&output.stdout).into_owned());
    }
    Err(decode_child_bytes(&output.stderr).trim().to_string())
}

impl Shared {
    pub(super) fn collaboration_is_plan(&self) -> bool {
        *self.collaboration.lock().unwrap() == Collaboration::Plan
    }

    pub(super) fn plan_marker(&self) -> Option<String> {
        self.collaboration_is_plan().then(|| "plan".to_string())
    }

    pub(super) fn set_collaboration_mode(&self, mode: &str) -> Result<(), AgentError> {
        let next = match mode {
            "plan" => Collaboration::Plan,
            "default" => Collaboration::Default,
            _ => {
                return Err(AgentError::Runtime(format!("未知协作模式：{mode}")));
            }
        };
        *self.collaboration.lock().unwrap() = next;
        emit(
            &self.events,
            SessionEventBody::CollaborationMode {
                mode: next.as_str().to_string(),
            },
        );
        Ok(())
    }

    pub(super) fn plan_model(&self) -> Result<String, AgentError> {
        if let Some(model) = self.model_override.lock().unwrap().clone() {
            if !model.trim().is_empty() {
                return Ok(model);
            }
        }
        let model = self.model.lock().unwrap().clone();
        if model.trim().is_empty() {
            Err(AgentError::Runtime("计划模式需要当前线程的模型。".into()))
        } else {
            Ok(model)
        }
    }

    pub(super) fn attach_plan_mode(&self, params: &mut Value) -> Result<(), AgentError> {
        let plan = self.collaboration_is_plan();
        let model = match self.plan_model() {
            Ok(model) => model,
            Err(err) if plan => return Err(err),
            Err(_) => return Ok(()),
        };
        let effort = self.effort.lock().unwrap().clone();
        params["collaborationMode"] = if plan {
            plan_collaboration_mode(&model, effort.as_deref())
        } else {
            collaboration_mode_value("default", &model, effort.as_deref())
        };
        Ok(())
    }

    pub(super) async fn start_review(&self, target: &ReviewStart) -> Result<(), AgentError> {
        self.ensure_open()?;
        if self.read_only() {
            return Err(AgentError::Runtime(
                crate::models::OCCUPIED_SESSION_NOTICE.into(),
            ));
        }
        if !self.pending.lock().unwrap().is_empty() {
            return Err(AgentError::PendingPrompt);
        }
        if self.turn_open.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(AgentError::Busy);
        }
        self.ensure_thread().await?;
        let thread_id = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AgentError::Runtime("Codex 线程未建立".into()))?;
        let params = json!({
            "threadId": thread_id,
            "target": review_protocol(target),
            "delivery": "inline",
        });
        self.turn_open
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if !self.write_method("review/start", params) {
            self.turn_open
                .store(false, std::sync::atomic::Ordering::SeqCst);
            return Err(AgentError::Runtime("无法向 Codex CLI 写入审查".into()));
        }
        Ok(())
    }

    pub(super) fn note_review_output(&self, id: &str, text: &str) {
        let trimmed = text.trim();
        *self.review_output.lock().unwrap() = if trimmed.is_empty() {
            None
        } else {
            let id = if id.trim().is_empty() {
                "review".to_string()
            } else {
                id.trim().to_string()
            };
            Some((id, trimmed.to_string()))
        };
    }

    /// 退出审查后的 agentMessage 与 findings 原文相同。返回审查 item id，调用方写入 `dedupe_of`。
    pub(super) fn take_review_duplicate(&self, text: &str) -> Option<String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }
        let mut slot = self.review_output.lock().unwrap();
        match slot.as_ref() {
            Some((id, stored)) if stored == trimmed => {
                let id = id.clone();
                *slot = None;
                Some(id)
            }
            _ => None,
        }
    }

    /// `turn_runtime.rs::maybe_prompt_plan_implementation`：计划模式、本回合出现过 plan item、
    /// 没有排队的后续消息、也没有别的待答卡片时才问。
    pub(super) fn maybe_offer_implement_plan(&self) -> bool {
        let saw_plan = self
            .plan_ready
            .swap(false, std::sync::atomic::Ordering::SeqCst);
        if !saw_plan
            || !self.collaboration_is_plan()
            || !self.queued.lock().unwrap().is_empty()
            || !self.pending.lock().unwrap().is_empty()
        {
            return false;
        }
        let plan = self.latest_plan.lock().unwrap().clone();
        let usage = self
            .token_info
            .lock()
            .unwrap()
            .and_then(|info| info.plan_usage_label());
        let prompt_id = format!(
            "implement-plan-{}",
            self.next_id
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        );
        self.pending
            .lock()
            .unwrap()
            .insert(prompt_id.clone(), Pending::ImplementPlan);
        emit(
            &self.events,
            SessionEventBody::Prompt {
                prompt_id,
                prompt_kind: PromptKind::Choice,
                question: PLAN_IMPLEMENTATION_TITLE.to_string(),
                options: plan_implementation_options(plan.as_deref(), usage.as_deref()),
                questions: Vec::new(),
            },
        );
        true
    }

    pub(super) async fn accept_implement_plan(
        &self,
        prompt_id: &str,
        answer: &crate::models::PromptAnswer,
    ) -> Result<(), AgentError> {
        let crate::models::PromptAnswer::Single { value } = answer else {
            return Err(AgentError::Runtime("请选择一个选项".into()));
        };
        let options = plan_implementation_options(
            self.latest_plan.lock().unwrap().as_deref(),
            None,
        );
        let Some(choice) = options.iter().find(|option| option.id == value.trim()) else {
            self.pending
                .lock()
                .unwrap()
                .insert(prompt_id.to_string(), Pending::ImplementPlan);
            return Err(AgentError::Runtime("请选择一个选项".into()));
        };
        if let Some(reason) = &choice.disabled_reason {
            self.pending
                .lock()
                .unwrap()
                .insert(prompt_id.to_string(), Pending::ImplementPlan);
            return Err(AgentError::Runtime(reason.clone()));
        }
        self.resolve_prompt(prompt_id, choice.label.clone());
        match choice.id.as_str() {
            IMPLEMENT_ID => {
                self.set_collaboration_mode("default")?;
                self.submit_user_text(PLAN_IMPLEMENTATION_CODING_MESSAGE.to_string())
                    .await
            }
            CLEAR_CONTEXT_ID => {
                let plan = self.latest_plan.lock().unwrap().clone().unwrap_or_default();
                emit(
                    &self.events,
                    SessionEventBody::NewThread {
                        name: None,
                        text: Some(format!("{PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX}\n\n{plan}")),
                    },
                );
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_targets_map_to_the_protocol() {
        assert_eq!(
            review_protocol(&ReviewStart::Uncommitted),
            json!({ "type": "uncommittedChanges" })
        );
        assert_eq!(
            review_protocol(&ReviewStart::Base { branch: "main".into() }),
            json!({ "type": "baseBranch", "branch": "main" })
        );
        let commit = review_protocol(&ReviewStart::Commit {
            sha: "abcdef1".into(),
            title: "Fix the parser".into(),
        });
        assert_eq!(commit["title"], json!("Fix the parser"));
        assert_eq!(
            review_protocol(&ReviewStart::Custom { instructions: "check auth".into() }),
            json!({ "type": "custom", "instructions": "check auth" })
        );
        let labels = review_labels(None);
        assert_eq!(labels.title, "Select a review preset");
        assert_eq!(labels.branch_subtitle, "Current branch: (detached HEAD)");
        assert_eq!(
            parse_commit_log("abc\u{1f}10\u{1f}seed\n\u{1f}\u{1f}bad").len(),
            1
        );
    }

    #[test]
    fn plan_card_matches_the_tui_copy() {
        let options = plan_implementation_options(Some("1. Do it"), Some("42% used"));
        let labels: Vec<_> = options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(
            labels,
            [
                "Yes, implement this plan",
                "Yes, clear context and implement",
                "No, stay in Plan mode"
            ]
        );
        assert_eq!(options[0].description, "Switch to Default and start coding");
        assert_eq!(
            options[1].description,
            "Start a fresh thread (current context: 42% used)"
        );
        assert!(options[1].disabled_reason.is_none());
        assert_eq!(options[2].description, "Continue planning with the model");
        let none = plan_implementation_options(None, None);
        assert_eq!(none[1].description, "Fresh thread with this plan");
        assert_eq!(
            none[1].disabled_reason.as_deref(),
            Some("No approved plan available")
        );
        assert_eq!(PLAN_IMPLEMENTATION_TITLE, "Implement this plan?");
        assert_eq!(PLAN_IMPLEMENTATION_CODING_MESSAGE, "Implement the plan.");
    }

    #[test]
    fn plan_mode_uses_built_in_instructions() {
        let value = plan_collaboration_mode("gpt-test", None);
        assert_eq!(value["mode"], json!("plan"));
        assert_eq!(value["settings"]["model"], json!("gpt-test"));
        assert!(value["settings"]["reasoning_effort"].is_null());
        assert!(value["settings"]["developer_instructions"].is_null());
        let text = value.to_string();
        assert!(!text.contains("Do not edit"));
        assert!(!text.contains("Plan only"));
        assert!(!text.contains("developer_instructions\":\""));
        let with_effort = plan_collaboration_mode("gpt-test", Some("medium"));
        assert_eq!(with_effort["settings"]["reasoning_effort"], json!("medium"));
        let default_mode = collaboration_mode_value("default", "gpt-test", None);
        assert_eq!(default_mode["mode"], json!("default"));
        assert!(default_mode["settings"]["developer_instructions"].is_null());
    }

    #[test]
    fn parses_official_review_comments() {
        let raw = "The change looks safe.\n\nFull review comments:\n\n- Missing null check — src/main.rs:10-12\n  The pointer is unchecked.\n- Rename the helper — src/lib.rs:1-1\n  The name hides the effect.";
        let SessionEventBody::ReviewFindings {
            summary,
            findings,
            raw: stored,
        } = parse_review_output(raw)
        else {
            panic!("findings");
        };
        assert_eq!(summary, "The change looks safe.");
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[0].title, "Missing null check");
        assert_eq!(findings[0].location, "src/main.rs:10-12");
        assert_eq!(findings[0].body, "The pointer is unchecked.");
        assert_eq!(findings[1].title, "Rename the helper");
        assert_eq!(stored, raw);
        let fallback = parse_review_output("Reviewer failed to output a response.");
        let SessionEventBody::ReviewFindings {
            summary, findings, ..
        } = fallback
        else {
            panic!("fallback");
        };
        assert_eq!(summary, "Reviewer failed to output a response.");
        assert!(findings.is_empty());
    }

    #[test]
    fn plan_steps_keep_protocol_status() {
        let body = plan_steps_event(&json!({
            "turnId": "turn-1",
            "explanation": "Ship the parser first.",
            "plan": [
                { "step": "Read the schema", "status": "completed" },
                { "step": "Render findings", "status": "inProgress" }
            ]
        }))
        .unwrap();
        let SessionEventBody::PlanSteps {
            turn_id,
            explanation,
            steps,
            mode,
        } = body
        else {
            panic!("steps");
        };
        assert_eq!(mode.as_deref(), Some("plan"));
        assert_eq!(turn_id, "turn-1");
        assert_eq!(explanation, "Ship the parser first.");
        assert_eq!(steps[1].status, "inProgress");
        assert!(plan_steps_event(&json!({ "plan": [] })).is_none());
    }

    #[tokio::test]
    async fn review_targets_put_the_default_branch_first() {
        let root = std::env::temp_dir().join(format!("aiw-review-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let run = |args: &[&str]| {
            assert!(std::process::Command::new("git")
                .args(args)
                .current_dir(&root)
                .status()
                .unwrap()
                .success());
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@example.com"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(root.join("a"), "1").unwrap();
        run(&["add", "a"]);
        run(&["commit", "-qm", "seed"]);
        run(&["branch", "aaa"]);
        run(&["checkout", "-q", "-b", "topic"]);
        let targets = git_review_targets(&root.to_string_lossy()).await;
        assert_eq!(targets.branches, ["main", "aaa", "topic"]);
        assert_eq!(targets.current_branch.as_deref(), Some("topic"));
        assert_eq!(targets.labels.branch_subtitle, "Current branch: topic");
        assert_eq!(targets.commits[0].title, "seed");
        let _ = std::fs::remove_dir_all(&root);
    }
}
