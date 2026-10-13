use super::skills::attachable_skill_path;
use super::*;
use crate::models::PageAnnotation;

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
