//! Codex 桌面端已经在用的 review / plan / diff / revert。
//! 这里只组协议参数和解析官方文本，不另写一套给模型的提示。

use std::process::Stdio;

use serde_json::{json, Value};
use tokio::process::Command;

use crate::encoding::decode_child_bytes;
use crate::features::agents::AgentError;
use crate::models::{
    PlanStep, PromptKind, PromptOption, ReviewFinding, ReviewStart, ReviewTargets,
    SessionEventBody, SessionStatus,
};

use super::process::hide_console;
use super::state::{emit, emit_status, Collaboration, Pending, Shared};

pub(super) const REVIEW_DESCRIPTION: &str = "审查未提交的更改，或与某个分支进行比较";
pub(super) const IMPLEMENT_PROMPT: &str = "实施此计划？";
pub(super) const IMPLEMENT_OPTION: &str = "是，实施此计划";
pub(super) const IMPLEMENT_ID: &str = "implement";
pub(super) const EDIT_LATEST_ONLY: &str = "无法编辑消息";
pub(super) const EDIT_WHILE_RUNNING: &str = "无法编辑消息";

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
    }
}

/// 空参数表示打开桌面端的目标菜单，不发回合。
pub(super) fn parse_review_slash(rest: &str) -> Result<Option<ReviewStart>, AgentError> {
    let rest = rest.trim();
    if rest.is_empty() {
        return Ok(None);
    }
    let mut parts = rest.splitn(2, char::is_whitespace);
    let head = parts.next().unwrap_or("").to_ascii_lowercase();
    let tail = parts.next().unwrap_or("").trim();
    match head.as_str() {
        "uncommitted" | "unstaged" => Ok(Some(ReviewStart::Uncommitted)),
        "base" | "branch" => {
            if tail.is_empty() {
                Err(AgentError::Runtime("用法：/review base <branch>".into()))
            } else {
                Ok(Some(ReviewStart::Base {
                    branch: tail.to_string(),
                }))
            }
        }
        "commit" => {
            let mut bits = tail.splitn(2, char::is_whitespace);
            let sha = bits.next().unwrap_or("").trim();
            if sha.is_empty() {
                Err(AgentError::Runtime("用法：/review commit <sha>".into()))
            } else {
                Ok(Some(ReviewStart::Commit {
                    sha: sha.to_string(),
                    title: bits.next().unwrap_or("").trim().to_string(),
                }))
            }
        }
        _ => Err(AgentError::Runtime(
            "用法：/review、/review uncommitted、/review base <branch>、/review commit <sha>"
                .into(),
        )),
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

/// 实验接口 `turn/start.collaborationMode`。`developer_instructions: null` 用内置计划说明。
pub(super) fn plan_collaboration_mode(model: &str, effort: Option<&str>) -> Value {
    json!({
        "mode": "plan",
        "settings": {
            "model": model,
            "reasoning_effort": effort,
            "developer_instructions": Value::Null,
        }
    })
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
    })
}

pub(super) async fn git_review_targets(cwd: &str) -> ReviewTargets {
    let branches = git(cwd, ["branch", "--format=%(refname:short)"]).await;
    let commits = git(cwd, ["log", "-15", "--format=%H%x09%s"]).await;
    let mut error = None;
    let branch_names = match branches {
        Ok(text) => text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect(),
        Err(err) => {
            error = Some(err);
            Vec::new()
        }
    };
    let commit_rows = match commits {
        Ok(text) => text
            .lines()
            .filter_map(|line| {
                let (sha, title) = line.split_once('\t')?;
                let sha = sha.trim();
                if sha.is_empty() {
                    return None;
                }
                Some(crate::models::ReviewCommit {
                    sha: sha.to_string(),
                    title: title.trim().to_string(),
                })
            })
            .collect(),
        Err(err) => {
            if error.is_none() {
                error = Some(err);
            }
            Vec::new()
        }
    };
    ReviewTargets {
        branches: branch_names,
        commits: commit_rows,
        error,
    }
}

async fn git<const N: usize>(cwd: &str, args: [&str; N]) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let output = command.output().await.map_err(|err| err.to_string())?;
    if output.status.success() {
        return Ok(decode_child_bytes(&output.stdout).into_owned());
    }
    let stderr = decode_child_bytes(&output.stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        Err("git failed".into())
    } else {
        Err(stderr.to_string())
    }
}

impl Shared {
    pub(super) fn collaboration_is_plan(&self) -> bool {
        *self.collaboration.lock().unwrap() == Collaboration::Plan
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
        if !self.collaboration_is_plan() {
            return Ok(());
        }
        let model = self.plan_model()?;
        let effort = self.effort.lock().unwrap().clone();
        params["collaborationMode"] = plan_collaboration_mode(&model, effort.as_deref());
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
        emit_status(&self.events, SessionStatus::Running);
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

    pub(super) async fn revert_turn(&self, turn_id: &str) -> Result<(), AgentError> {
        self.ensure_open()?;
        if self.read_only() {
            return Err(AgentError::Runtime(
                crate::models::OCCUPIED_SESSION_NOTICE.into(),
            ));
        }
        if self.turn_open.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(AgentError::Runtime(EDIT_WHILE_RUNNING.into()));
        }
        let latest = self
            .latest_turn_id
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_default();
        if latest.is_empty() || latest != turn_id {
            return Err(AgentError::Runtime(EDIT_LATEST_ONLY.into()));
        }
        self.ensure_thread().await?;
        let thread_id = self.thread_id.lock().unwrap().clone().unwrap_or_default();
        if thread_id.is_empty() {
            return Err(AgentError::Runtime("Codex 线程未建立".into()));
        }
        self.request(
            "thread/revert",
            json!({ "threadId": thread_id, "beforeTurnId": turn_id }),
        )
        .await?;
        *self.latest_turn_id.lock().unwrap() = None;
        emit(
            &self.events,
            SessionEventBody::Rewind {
                turn_id: turn_id.to_string(),
                drop_from_seq: 0,
            },
        );
        Ok(())
    }

    pub(super) fn note_review_output(&self, text: &str) {
        let trimmed = text.trim();
        *self.review_output.lock().unwrap() = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
    }

    /// 退出审查后的 agentMessage 与 findings 原文相同，不再画第二条。
    pub(super) fn consume_review_duplicate(&self, text: &str) -> bool {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return false;
        }
        let mut slot = self.review_output.lock().unwrap();
        if slot.as_deref() == Some(trimmed) {
            *slot = None;
            true
        } else {
            false
        }
    }

    pub(super) fn maybe_offer_implement_plan(&self) -> bool {
        let ready = self
            .plan_ready
            .swap(false, std::sync::atomic::Ordering::SeqCst);
        if !ready || !self.collaboration_is_plan() || !self.pending.lock().unwrap().is_empty() {
            return false;
        }
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
                question: IMPLEMENT_PROMPT.to_string(),
                options: vec![PromptOption {
                    id: IMPLEMENT_ID.into(),
                    label: IMPLEMENT_OPTION.into(),
                    description: String::new(),
                }],
                questions: Vec::new(),
            },
        );
        emit_status(&self.events, SessionStatus::NeedsInput);
        true
    }

    pub(super) async fn accept_implement_plan(
        &self,
        prompt_id: &str,
        answer: &crate::models::PromptAnswer,
    ) -> Result<(), AgentError> {
        let crate::models::PromptAnswer::Single { value } = answer else {
            return Err(AgentError::Runtime("请选择实现计划，或输入其他回复".into()));
        };
        let value = value.trim();
        if value.is_empty() {
            return Err(AgentError::Runtime("回复不能为空".into()));
        }
        let implement = value == IMPLEMENT_ID || value == IMPLEMENT_OPTION;
        let shown = if implement {
            IMPLEMENT_OPTION.to_string()
        } else {
            value.to_string()
        };
        self.resolve_prompt(prompt_id, shown.clone());
        if implement {
            self.set_collaboration_mode("default")?;
        }
        emit(
            &self.events,
            SessionEventBody::UserMessage {
                text: shown.clone(),
                images: Vec::new(),
            },
        );
        self.begin_turn(shown).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_slash_keeps_the_three_official_targets() {
        assert!(parse_review_slash("").unwrap().is_none());
        assert_eq!(
            parse_review_slash("uncommitted").unwrap(),
            Some(ReviewStart::Uncommitted)
        );
        assert_eq!(
            review_protocol(&ReviewStart::Uncommitted),
            json!({ "type": "uncommittedChanges" })
        );
        let base = parse_review_slash("base main").unwrap().unwrap();
        assert_eq!(
            review_protocol(&base),
            json!({ "type": "baseBranch", "branch": "main" })
        );
        assert_eq!(ReviewStart::Uncommitted.label(), "审查未提交的更改");
        assert_eq!(base.label(), "对照基础分支审查: main");
        let commit = parse_review_slash("commit abcdef1 Fix the parser")
            .unwrap()
            .unwrap();
        assert!(commit.label().starts_with("提交"));
        assert_eq!(review_protocol(&commit)["type"], json!("commit"));
        assert_eq!(review_protocol(&commit)["sha"], json!("abcdef1"));
        assert_eq!(review_protocol(&commit)["title"], json!("Fix the parser"));
        assert!(parse_review_slash("please look").is_err());
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
        } = body
        else {
            panic!("steps");
        };
        assert_eq!(turn_id, "turn-1");
        assert_eq!(explanation, "Ship the parser first.");
        assert_eq!(steps[1].status, "inProgress");
        assert!(plan_steps_event(&json!({ "plan": [] })).is_none());
    }

    #[tokio::test]
    async fn review_targets_come_from_the_gap_project() {
        let cwd = r"C:\Users\admin\Desktop\temp\ai-workbench-project\_gap-review-plan";
        assert!(
            std::path::Path::new(cwd).join(".git").exists(),
            "the gap project must already be a git repo"
        );
        let targets = git_review_targets(cwd).await;
        assert!(targets.error.is_none(), "{:?}", targets.error);
        assert!(
            targets
                .branches
                .iter()
                .any(|branch| branch == "main" || branch == "master"),
            "{:?}",
            targets.branches
        );
        assert!(
            targets
                .commits
                .iter()
                .any(|commit| commit.title.contains("seed")),
            "{:?}",
            targets.commits
        );
    }
}
