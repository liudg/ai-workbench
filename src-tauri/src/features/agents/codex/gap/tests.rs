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
