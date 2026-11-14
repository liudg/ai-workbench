//! 报文取自 2026-11-09 本机 agy 1.5.3 的 `agy acp` 实际收发（路径缩短）。

use std::path::Path;

use serde_json::{json, Value};

use super::catalog;
use super::dialect::{task_steps, RULES};
use super::elicitation;
use super::open;
use super::permission;
use super::subagents::Subagents;
use super::subscription;
use crate::acp::updates::UpdateMap;
use crate::acp::{PendingAnswer, UpdateRules};
use aiwb_core::models::{AgentCatalog, FileStatus, PromptAnswer, PromptKind, SessionEventBody, SubagentStatus, ToolStatus};

const PROJECT: &str = r"C:\ws";

fn map() -> UpdateMap {
    let mut map = UpdateMap::new(Path::new(PROJECT), &RULES);
    map.begin_turn("t1");
    map
}

fn tools(events: &[SessionEventBody]) -> Vec<(String, String, String, ToolStatus, Option<i64>)> {
    events
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::ToolCall { name, summary, detail, status, exit_code, .. } => {
                Some((name.clone(), summary.clone(), detail.clone(), *status, *exit_code))
            }
            _ => None,
        })
        .collect()
}

#[test]
fn commands_drop_the_exit_preamble_and_the_repeated_content() {
    let mut map = map();
    let output = "Command exited with code 0.\n\nCommand output:\ntool-ok\r\n";
    let input = json!({"CommandLine":"echo tool-ok","WaitMsBeforeAsync":5000,"toolSummary":"Run echo command"});
    let update = json!({
        "sessionUpdate":"tool_call_update","toolCallId":"call_1","name":"run_command","status":"completed","kind":"execute",
        "title":"echo tool-ok","rawInput":input,"rawOutput":{"output":output,"exit_code":0},
        "content":[{"type":"content","content":{"type":"text","text":output}}]
    });
    let found = tools(&map.apply(&update));
    assert_eq!(found, vec![("command".to_string(), "echo tool-ok".to_string(), "tool-ok".to_string(), ToolStatus::Completed, Some(0))]);
}

#[test]
fn a_command_without_output_has_an_empty_detail_and_a_failure_keeps_its_code() {
    let mut map = map();
    let none = "Command exited with code 0.\n\nNo output from the command.";
    let update = json!({"sessionUpdate":"tool_call_update","toolCallId":"a","name":"run_command","status":"completed","kind":"execute",
        "title":"x","rawInput":{"CommandLine":"x"},"rawOutput":{"output":none,"exit_code":0},"content":[{"type":"content","content":{"type":"text","text":none}}]});
    assert_eq!(tools(&map.apply(&update))[0].2, "");
    let failed = "Command exited with code 3.\n\nCommand output:\nboom\r\n";
    let update = json!({"sessionUpdate":"tool_call_update","toolCallId":"b","name":"run_command","status":"completed","kind":"execute",
        "title":"y","rawInput":{"CommandLine":"y"},"rawOutput":{"output":failed,"exit_code":3}});
    let found = tools(&map.apply(&update));
    assert_eq!(found[0].2, "boom");
    assert_eq!(found[0].3, ToolStatus::Failed);
    assert_eq!(found[0].4, Some(3));
}

#[test]
fn edits_use_project_paths_and_lose_the_extra_trailing_newline() {
    let mut map = map();
    let update = json!({
        "sessionUpdate":"tool_call_update","toolCallId":"c","name":"edit_file","status":"completed","kind":"edit",
        "title":"File /C:/ws/n.txt","rawInput":{"Path":"C:\\ws\\n.txt","Target":"two","Replacement":"TWO"},"rawOutput":{},
        "content":[{"type":"diff","path":"/C:/ws/n.txt","oldText":"one\ntwo\n\n","newText":"one\nTWO\n\n"}]
    });
    let events = map.apply(&update);
    assert_eq!(tools(&events)[0].1, "n.txt");
    let change = events.iter().find_map(|event| match event {
        SessionEventBody::FileChange { path, status, added, removed, diff, .. } => Some((path.clone(), *status, *added, *removed, diff.clone())),
        _ => None,
    });
    let (path, status, added, removed, diff) = change.unwrap();
    assert_eq!(path, "n.txt");
    assert_eq!(status, FileStatus::Modified);
    assert_eq!((added, removed), (1, 1));
    assert!(diff.contains("+TWO") && !diff.contains("+\n"), "{diff}");
}

#[test]
fn a_new_file_is_added_and_a_plan_artifact_is_plan_text_not_a_change() {
    let mut map = map();
    map.plan_mode = true;
    let events = map.apply(&json!({
        "sessionUpdate":"tool_call_update","toolCallId":"d","name":"write_file","status":"completed","kind":"edit",
        "title":"File /C:/ws/b.txt","rawInput":{"Path":"C:\\ws\\b.txt","Content":"created.\n"},"rawOutput":{},
        "content":[{"type":"diff","path":"/C:/ws/b.txt","newText":"created.\n\n"}]
    }));
    assert!(events.iter().any(|event| matches!(event, SessionEventBody::FileChange { status: FileStatus::Added, .. })));
    let brain = "C:\\Users\\a\\.gemini\\antigravity-cli\\brain\\31d86854-654f-462f-b435-1114b5323f19\\implementation_plan.md";
    let events = map.apply(&json!({
        "sessionUpdate":"tool_call","toolCallId":"e","name":"write_file","status":"in_progress","kind":"edit","title":"File plan",
        "rawInput":{"ArtifactMetadata":{"RequestFeedback":true},"Content":"## Plan\n\nDo it.\n","Path":brain}
    }));
    assert_eq!(events.len(), 1);
    assert!(matches!(&events[0], SessionEventBody::PlanText { text, mode, .. } if text.starts_with("## Plan") && mode.as_deref() == Some("plan")));
    assert_eq!(map.take_plan().as_deref(), Some("## Plan\n\nDo it.\n"));
}

#[test]
fn other_artifacts_are_cards_without_changes_and_task_lists_are_steps() {
    let mut map = map();
    let root = "C:/Users/a/.gemini/antigravity-cli/brain/31d86854-654f-462f-b435-1114b5323f19";
    let events = map.apply(&json!({
        "sessionUpdate":"tool_call_update","toolCallId":"f","name":"write_file","status":"completed","kind":"edit","title":"t",
        "rawInput":{"Path":format!("{root}/walkthrough.md"),"Content":"w"},"rawOutput":{},
        "content":[{"type":"diff","path":format!("/{root}/walkthrough.md"),"newText":"w\n"}]
    }));
    assert_eq!(tools(&events).len(), 1);
    assert!(!events.iter().any(|event| matches!(event, SessionEventBody::FileChange { .. })));
    let events = map.apply(&json!({
        "sessionUpdate":"tool_call","toolCallId":"g","name":"write_file","status":"in_progress","kind":"edit","title":"t",
        "rawInput":{"Path":format!("{root}/task.md"),"Content":"# T\n- [x] a\n  - [/] b\n- [ ] c\nnote\n"}
    }));
    let SessionEventBody::PlanSteps { steps, .. } = &events[0] else { panic!("{events:?}") };
    let got: Vec<(&str, &str)> = steps.iter().map(|step| (step.step.as_str(), step.status.as_str())).collect();
    assert_eq!(got, [("a", "completed"), ("b", "inProgress"), ("c", "pending")]);
    assert!(task_steps("no list").is_empty());
}

#[test]
fn question_tools_are_hidden_and_goal_markers_are_not_shown() {
    let mut map = map();
    assert!(map.apply(&json!({"sessionUpdate":"tool_call","toolCallId":"h","name":"ask_question","status":"in_progress","kind":"other","title":"Run ask_question","rawInput":{}})).is_empty());
    let events = map.apply(&json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Done.\n\n<!-- GOAL_COMPLETE -->"}}));
    assert!(matches!(&events[0], SessionEventBody::AgentMessage { text, .. } if text == "Done."));
    assert!(map.last_message().contains("GOAL_COMPLETE"));
}

#[test]
fn mcp_tools_keep_the_workbench_name_shape() {
    assert_eq!(RULES.tool_name("other", "Run mcp_aiwb_aiwb_ping", "mcp_aiwb_aiwb_ping"), "mcp__aiwb__aiwb_ping");
    assert_eq!(RULES.tool_name("other", "Run manage_task", "manage_task"), "manage_task");
    assert_eq!(RULES.tool_name("read", "File a", "read_file"), "Read");
}

#[test]
fn a_background_command_finishes_its_running_card() {
    let mut map = map();
    map.apply(&json!({
        "sessionUpdate":"tool_call","toolCallId":"bg","name":"run_command","status":"in_progress","kind":"execute",
        "title":"Start-Sleep -Seconds 25; echo slow-done","rawInput":{"CommandLine":"Start-Sleep -Seconds 25; echo slow-done"}
    }));
    let event = map
        .finish_command("Start-Sleep -Seconds 25; echo slow-done", "Command exited with code 0.\n\nCommand output:\nslow-done\r\n")
        .expect("running card");
    let SessionEventBody::ToolCall { status, detail, exit_code, .. } = event else { panic!() };
    assert_eq!((status, detail.as_str(), exit_code), (ToolStatus::Completed, "slow-done", Some(0)));
    assert!(map.finish_command("Start-Sleep -Seconds 25; echo slow-done", "x").is_none());
}

#[test]
fn background_tasks_are_awaited_until_their_result_arrives() {
    let dir = super::regression_tests::DataRoot::new();
    let id = "3f86e1c1-ca85-469f-946a-4877264ee320";
    let logs = dir.path().join("antigravity-cli").join("brain").join(id).join(".system_generated").join("logs");
    std::fs::create_dir_all(&logs).unwrap();
    let started = json!({"step_index":31,"type":"GENERIC","status":"RUNNING","content":format!(
        "Created At: x\nTool is running as a background task with task id: {id}/task-31\nTask Description: Start-Sleep -Seconds 25; echo slow-done\nTask logs are available at: file:///x")});
    let reply = json!({"step_index":32,"type":"PLANNER_RESPONSE","status":"DONE","content":"I have launched the command."});
    let write = |steps: &[&Value]| {
        let text: String = steps.iter().map(|step| format!("{step}\n")).collect();
        std::fs::write(logs.join("transcript.jsonl"), text).unwrap();
    };
    write(&[&started, &reply]);
    let mut tail = super::subagents::ParentTail::new(id);
    assert!(tail.waiting_on_tasks());
    assert!(!tail.settled(&[]));
    let finished = json!({"step_index":35,"type":"SYSTEM_MESSAGE","status":"DONE","content":format!(
        "<SYSTEM_MESSAGE>\n[Message] timestamp=t sender={id}/task-31 priority=MESSAGE_PRIORITY_HIGH content=Task id \"{id}/task-31\" finished with result:\nCommand exited with code 0.\n\nCommand output:\nslow-done\n\nLog: file:///x\n</SYSTEM_MESSAGE>")});
    let answer = json!({"step_index":36,"type":"PLANNER_RESPONSE","status":"DONE","content":"The command finished with output: slow-done"});
    write(&[&started, &reply, &finished, &answer]);
    let updates = tail.read();
    let done = tail.take_finished();
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].command, "Start-Sleep -Seconds 25; echo slow-done");
    assert!(done[0].result.ends_with("slow-done") && !done[0].result.contains("Log:"));
    assert!(updates.iter().any(|update| update["content"]["text"] == "The command finished with output: slow-done"));
    assert!(!tail.waiting_on_tasks() && tail.settled(&[]));
}

#[test]
fn typed_goal_commands_carry_their_objective() {
    use super::dialect::goal_objective;
    assert_eq!(goal_objective("/goal create done.txt"), Some("create done.txt"));
    assert_eq!(goal_objective("  /goal   ship it  "), Some("ship it"));
    assert_eq!(goal_objective("/goal clear"), Some("clear"));
    assert_eq!(goal_objective("/goal"), None);
    assert_eq!(goal_objective("/goals x"), None);
    assert_eq!(goal_objective("please /goal x"), None);
}

#[test]
fn generated_images_attach_to_their_tool_card() {
    let mut map = map();
    let text = "Created At: x\nGenerated image is saved at C:\\a\\red_circle_1.jpg.";
    let events = map.apply(&json!({
        "sessionUpdate":"tool_call_update","toolCallId":"i","name":"generate_image","status":"completed","kind":"other","title":"Run generate_image",
        "rawInput":{"Prompt":"red"},"content":[{"type":"content","content":{"type":"text","text":text}}]
    }));
    let SessionEventBody::ToolCall { name, images, .. } = &events[0] else { panic!("{events:?}") };
    assert_eq!(name, "image_generation");
    assert_eq!(images, &vec![r"C:\a\red_circle_1.jpg".to_string()]);
}

#[test]
fn backend_error_text_fails_the_turn() {
    let mut map = map();
    assert!(map.apply(&json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"\n⚠ Agent execution terminated due to error.\n"}})).is_empty());
    assert_eq!(map.take_error().as_deref(), Some(""));
    assert_eq!(RULES.error_message(""), "Antigravity 这一轮因错误中止。");
}

#[test]
fn replay_rebuilds_user_turns_and_paths() {
    let mut map = UpdateMap::new(Path::new(PROJECT), &RULES);
    let mut events = map.apply(&json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"PING"}}));
    events.extend(map.apply(&json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"PONG"}})));
    events.extend(map.finish_replay());
    assert!(events.iter().any(|event| matches!(event, SessionEventBody::UserMessage { text, .. } if text == "PING")));
    assert!(events.iter().any(|event| matches!(event, SessionEventBody::AgentMessage { text, .. } if text == "PONG")));
}

fn session_payload() -> Value {
    json!({
        "sessionId":"s",
        "models":{"availableModels":[
            {"modelId":"gemini-4-argon-medium","name":"Gemini 4 Argon (Medium)"},
            {"modelId":"gemini-4-argon-high","name":"Gemini 4 Argon (High)"},
            {"modelId":"gemini-4-argon-low","name":"Gemini 4 Argon (Low)"},
            {"modelId":"gpt-oss-120b-medium","name":"GPT-OSS 120B (Medium)"}
        ],"currentModelId":"gemini-4-argon-medium"},
        "modes":{"currentModeId":"default"},
        "configOptions":[
            {"id":"model","name":"Model","category":"model","type":"select","currentValue":"gemini-4-argon","options":[
                {"value":"gemini-4-argon","name":"Gemini 4 Argon"},{"value":"gpt-oss-120b-medium","name":"GPT-OSS 120B (Medium)"}]},
            {"id":"thought_level","name":"Thinking Level","category":"thought_level","type":"select","currentValue":"high","options":[
                {"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"}]}
        ]
    })
}

#[test]
fn models_are_families_with_their_own_efforts() {
    let mut catalog = AgentCatalog::empty();
    catalog::apply_session(&mut catalog, &session_payload());
    assert_eq!(catalog.models.len(), 2);
    let argon = &catalog.models[0];
    assert_eq!(argon.id, "gemini-4-argon");
    assert!(argon.is_default);
    assert_eq!(argon.default_effort, "high");
    assert_eq!(argon.efforts.iter().map(|effort| effort.id.as_str()).collect::<Vec<_>>(), ["low", "medium", "high"]);
    let oss = &catalog.models[1];
    assert_eq!(oss.id, "gpt-oss-120b-medium");
    assert!(oss.efforts.is_empty());
    assert_eq!(oss.default_effort, "");
}

fn question_params() -> Value {
    json!({
        "sessionId":"s","toolCallId":"c","mode":"form","message":"The agent has 2 questions.",
        "requestedSchema":{"type":"object","properties":{
            "q1":{"type":"array","title":"Pick fruits","items":{"anyOf":[{"const":"1","title":"Apple"},{"const":"2","title":"Pear"},{"const":"3","title":"Kiwi"}]}},
            "q1_other":{"type":"string","title":"Other","description":"Optional free-form answer to: Pick fruits"},
            "q2":{"type":"string","title":"Pick size","oneOf":[{"const":"1","title":"(Recommended) S"},{"const":"2","title":"M"}]},
            "q2_other":{"type":"string","title":"Other","description":"Optional free-form answer to: Pick size"}
        }}
    })
}

#[test]
fn forms_become_questions_and_answers_use_the_consts() {
    let (event, pending) = elicitation::question_prompt("p", &question_params());
    let SessionEventBody::Prompt { prompt_kind, questions, .. } = event else { panic!() };
    assert_eq!(prompt_kind, PromptKind::Questions);
    assert_eq!(questions.iter().map(|question| question.id.as_str()).collect::<Vec<_>>(), ["q1", "q2"]);
    assert!(questions[0].multi_select && questions[0].is_other && !questions[1].multi_select);
    assert_eq!(questions[1].options[0].label, "S");
    assert_eq!(questions[1].options[0].description, "推荐");
    let answer = PromptAnswer::Questions {
        answers: [("q1".to_string(), "Apple, Kiwi".to_string()), ("q2".to_string(), "M".to_string())].into_iter().collect(),
        skipped: false,
    };
    let (reply, label) = pending.respond(&answer).unwrap();
    assert_eq!(reply, json!({"action":"accept","content":{"q1":["1","3"],"q2":"2"}}));
    assert_eq!(label, "Apple, Kiwi；M");
}

#[test]
fn free_text_goes_to_the_other_field_and_skips_decline() {
    let (_, pending) = elicitation::question_prompt("p", &question_params());
    let answer = PromptAnswer::Questions {
        answers: [("q2".to_string(), "XL please".to_string())].into_iter().collect(),
        skipped: false,
    };
    assert_eq!(pending.respond(&answer).unwrap().0, json!({"action":"accept","content":{"q2_other":"XL please"}}));
    let skip = PromptAnswer::Questions { answers: Default::default(), skipped: true };
    assert_eq!(pending.respond(&skip).unwrap().0, json!({"action":"decline"}));
    assert_eq!(pending.cancelled(), json!({"action":"cancel"}));
}

#[test]
fn subagent_calls_make_a_running_card() {
    let mut subagents = Subagents::new(Path::new(PROJECT));
    let events = subagents
        .apply("parent", &json!({
            "sessionUpdate":"tool_call","toolCallId":"call_9","name":"invoke_subagent","status":"in_progress","kind":"other","title":"Run invoke_subagent",
            "rawInput":{"Prompt":"Read a.txt","Role":"File Reader","TypeName":"research"}
        }))
        .unwrap();
    let SessionEventBody::Subagent(card) = &events[0] else { panic!() };
    assert_eq!(card.title, "File Reader");
    assert_eq!(card.agent_type, "research");
    assert_eq!(card.prompt, "Read a.txt");
    assert_eq!(card.status, SubagentStatus::Running);
    assert!(subagents.apply("parent", &json!({"sessionUpdate":"tool_call","name":"read_file","toolCallId":"x"})).is_none());
    let stopped = subagents.stop_all();
    assert!(matches!(&stopped[0], SessionEventBody::Subagent(card) if card.status == SubagentStatus::Stopped));
}

#[test]
fn usage_groups_become_labelled_windows() {
    let payload = json!({"command":{"name":"usage","data":{"groups":[
        {"name":"Gemini Models","description":"Models within this group: Gemini 4 Carbon, Orchestrator (Carbon), Gemini 3.8 Flash","buckets":[
            {"id":"gemini-weekly","window":"weekly","remaining_fraction":0.9878,"reset_time":"2026-11-16T06:34:09Z"},
            {"id":"gemini-5h","window":"5h","remaining_fraction":0.5,"reset_time":"2026-11-09T11:34:09Z"}]},
        {"name":"Claude and GPT models","description":"Shared quota.","buckets":[
            {"id":"3p-weekly","window":"weekly","remaining_fraction":0,"reset_time":"2026-11-18T09:32:19Z"}]}
    ]}}});
    let usage = subscription::parse(&payload);
    assert_eq!(usage.windows.len(), 3);
    assert_eq!(usage.windows[0].label, "Gemini Models · 每周");
    assert_eq!(usage.windows[1].label, "Gemini Models · 5 小时");
    assert_eq!(usage.windows[1].remaining_percent, Some(50.0));
    assert_eq!(usage.windows[1].resets_at_ms, Some(1794224049000));
    assert_eq!(usage.windows[1].models, ["Gemini 4 Carbon", "Orchestrator (Carbon)", "Gemini 3.8 Flash"]);
    // 描述不是模型列表时不猜。
    assert!(usage.windows[2].models.is_empty());
    assert!(subscription::parse(&json!({})).windows.is_empty());
}

#[test]
fn listed_sessions_use_plain_windows_paths() {
    let entry = open::entry_for_test(&json!({"sessionId":"1","cwd":"/C:/Work/App","title":" T ","updatedAt":"2026-11-09T10:56:22Z"})).unwrap();
    assert_eq!(entry.cwd, r"C:\Work\App");
    assert_eq!(entry.cwd_key, aiwb_core::models::cwd_key(r"c:\work\app"));
    assert_eq!(entry.title, "T");
}

#[test]
fn the_project_sorts_before_extra_directories() {
    let plain = open::thread_params(Path::new(PROJECT), &[], json!([]), None);
    assert!(plain.get("_meta").is_none() && plain.get("additionalDirectories").is_none());
    assert_eq!(plain["cwd"], PROJECT);
    let roots = vec![r"C:\extra".to_string()];
    let params = open::thread_params(Path::new(r"c:\ws"), &roots, json!([]), Some("hello".into()));
    assert_eq!(params["cwd"], r"C:\ws");
    assert_eq!(params["additionalDirectories"], json!([r"c:\extra"]));
    assert_eq!(params["_meta"]["antigravity"]["systemPrompt"]["append"], "hello");
    let unix = open::thread_params(Path::new("/ws"), &["/extra".to_string()], json!([]), None);
    assert_eq!(unix["additionalDirectories"], json!(["/extra"]));
}

#[test]
fn the_host_nudge_is_not_a_user_message_on_replay() {
    let mut map = UpdateMap::new(Path::new(PROJECT), &RULES);
    let mut events = map.apply(&json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hello"}}));
    events.extend(map.apply(&json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"one"}})));
    events.extend(map.apply(&json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":super::dialect::NUDGE}})));
    events.extend(map.apply(&json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"two"}})));
    events.extend(map.finish_replay());
    let users: Vec<&str> = events.iter().filter_map(|event| match event {
        SessionEventBody::UserMessage { text, .. } => Some(text.as_str()),
        _ => None,
    }).collect();
    assert_eq!(users, ["hello"]);
}

#[test]
fn the_menu_lists_native_modes_and_extras() {
    let menu = permission::permission_menu("ask");
    assert_eq!(menu.presets.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), ["full", "approve-for-me", "ask"]);
    assert!(menu.writable_roots && !menu.network_access);
    assert_eq!(menu.active.as_deref(), Some("ask"));
}
