use crate::protocol::plan_choice::{
    classify_plan_answer, plan_implementation_options, PlanChoice, PLAN_IMPLEMENTATION_CODING_MESSAGE,
    PLAN_IMPLEMENTATION_TITLE,
};
use super::git::review_labels;
use super::*;

#[test]
fn review_targets_map_to_the_protocol() {
    assert_eq!(
        review_protocol(&ReviewStart::Uncommitted),
        json!({ "type": "uncommittedChanges" })
    );
    assert_eq!(
        review_protocol(&ReviewStart::Base {
            branch: "main".into()
        }),
        json!({ "type": "baseBranch", "branch": "main" })
    );
    let commit = review_protocol(&ReviewStart::Commit {
        sha: "abcdef1".into(),
        title: "Fix the parser".into(),
    });
    assert_eq!(commit["title"], json!("Fix the parser"));
    assert_eq!(
        review_protocol(&ReviewStart::Custom {
            instructions: "check auth".into()
        }),
        json!({ "type": "custom", "instructions": "check auth" })
    );
    let labels = review_labels(None);
    assert_eq!(labels.title, "Select a review preset");
    assert_eq!(labels.branch_subtitle, "Current branch: (detached HEAD)");
    assert_eq!(
        super::git::parse_commit_log("abc\u{1f}10\u{1f}seed\n\u{1f}\u{1f}bad").len(),
        1
    );
}

#[test]
fn plan_card_copy_is_chinese_and_pinned() {
    let options = plan_implementation_options(Some("1. Do it"), Some("42% used"));
    let labels: Vec<_> = options.iter().map(|o| o.label.as_str()).collect();
    assert_eq!(
        labels,
        ["是，实施此计划", "是，清空上下文并实施", "否，留在计划模式"]
    );
    assert_eq!(
        options.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(),
        ["implement", "clear-context", "stay"]
    );
    assert_eq!(
        options.iter().map(|o| o.slot.as_str()).collect::<Vec<_>>(),
        ["primary", "leading", "deny"]
    );
    assert_eq!(options[0].description, "切换到默认模式并开始编码");
    assert_eq!(
        options[1].description,
        "用这份计划开一个新线程（当前上下文：42% used）"
    );
    assert!(options[1].disabled_reason.is_none());
    assert_eq!(options[2].description, "继续和模型完善计划");
    let none = plan_implementation_options(None, None);
    assert_eq!(none[1].description, "用这份计划开一个新线程");
    assert_eq!(none[1].disabled_reason.as_deref(), Some("没有可实施的计划"));
    assert_eq!(PLAN_IMPLEMENTATION_TITLE, "实施此计划？");
    assert_eq!(PLAN_IMPLEMENTATION_CODING_MESSAGE, "Implement the plan.");
}

#[test]
fn plan_feedback_is_not_a_missing_option() {
    let PlanChoice::Selected(yes) = classify_plan_answer("implement", Some("1. Do it")).unwrap()
    else {
        panic!("implement");
    };
    assert_eq!(yes.id, "implement");
    let PlanChoice::Selected(stay) = classify_plan_answer(" stay ", Some("1. Do it")).unwrap()
    else {
        panic!("stay");
    };
    assert_eq!(stay.id, "stay");
    let PlanChoice::Feedback(text) =
        classify_plan_answer("蛇身再短一点", Some("1. Do it")).unwrap()
    else {
        panic!("feedback");
    };
    assert_eq!(text, "蛇身再短一点");
    assert_eq!(
        classify_plan_answer("   ", Some("1. Do it")).unwrap_err(),
        "请选择一个选项"
    );
    assert_eq!(
        classify_plan_answer("clear-context", None).unwrap_err(),
        "没有可实施的计划"
    );
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

#[test]
fn effort_falls_back_to_thread_effective_effort() {
    assert_eq!(
        pick_effort(None, Some("high".into())).as_deref(),
        Some("high")
    );
    assert_eq!(
        pick_effort(Some("low".into()), Some("high".into())).as_deref(),
        Some("low")
    );
    assert_eq!(
        pick_effort(Some(" ".into()), Some("high".into())).as_deref(),
        Some("high")
    );
    assert!(pick_effort(None, None).is_none());
    let effort = pick_effort(None, Some("high".into()));
    let mode = collaboration_mode_value("default", "gpt-test", effort.as_deref());
    assert_eq!(mode["settings"]["reasoning_effort"], json!("high"));
}
