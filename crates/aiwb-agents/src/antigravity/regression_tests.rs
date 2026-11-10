//! 恢复、子会话关联和后台等待的回归测试。

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::{catalog, dialect::AntigravityDialect, subagents::Subagents};
use crate::acp::{
    runtime::{Parts, Shared},
    session::AcpSession,
};
use crate::{AgentSession, UserTurn};
use aiwb_core::models::{SessionEventBody, SessionStatus, SubagentStatus, ToolStatus};

const PARENT: &str = "10000000-0000-4000-8000-000000000001";
const OLD: &str = "10000000-0000-4000-8000-000000000002";
const NEW: &str = "10000000-0000-4000-8000-000000000003";

/// 数据目录覆写是进程环境；所有用它的普通测试串行，并恢复调用前的值。
pub(super) struct DataRoot {
    dir: tempfile::TempDir,
    previous: Option<std::ffi::OsString>,
    _guard: MutexGuard<'static, ()>,
}

impl DataRoot {
    pub fn new() -> Self {
        static LOCK: Mutex<()> = Mutex::new(());
        let guard = LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("ANTIGRAVITY_GEMINI_DIR");
        std::env::set_var("ANTIGRAVITY_GEMINI_DIR", dir.path());
        Self {
            dir,
            previous,
            _guard: guard,
        }
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    fn transcript(&self, id: &str, steps: &[Value]) {
        let logs = super::directory::brain_dir(id)
            .unwrap()
            .join(".system_generated/logs");
        std::fs::create_dir_all(&logs).unwrap();
        let text: String = steps.iter().map(|step| format!("{step}\n")).collect();
        std::fs::write(logs.join("transcript.jsonl"), text).unwrap();
    }

    fn child(&self, id: &str, index: u64, answer: &str) {
        let records = super::directory::brain_dir(PARENT)
            .unwrap()
            .join(".system_generated/subagents");
        std::fs::create_dir_all(&records).unwrap();
        std::fs::write(
            records.join(format!("{id}.json")),
            json!({
                "conversationId": id, "spawnStepIndex": index,
                "subagentDescriptor": {"role":"Reader", "typeName":"research"}
            })
            .to_string(),
        )
        .unwrap();
        self.transcript(
            id,
            &[json!({"type":"PLANNER_RESPONSE", "content":answer, "status":"DONE"})],
        );
    }
}

impl Drop for DataRoot {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var("ANTIGRAVITY_GEMINI_DIR", value),
            None => std::env::remove_var("ANTIGRAVITY_GEMINI_DIR"),
        }
    }
}

fn spawn_step(index: u64, prompt: &str) -> [Value; 2] {
    [
        json!({"step_index":index-1,"type":"PLANNER_RESPONSE","tool_calls":[{
            "name":"invoke_subagent", "args":{"Role":"\"Reader\"","TypeName":"\"research\"","Prompt":json!(prompt).to_string()}
        }]}),
        json!({"step_index":index,"type":"GENERIC","status":"DONE"}),
    ]
}

fn invocation(id: &str, prompt: &str, status: &str) -> Value {
    json!({"sessionUpdate":"tool_call","name":"invoke_subagent","toolCallId":id,"status":status,
        "rawInput":{"Role":"Reader","TypeName":"research","Prompt":prompt}})
}

#[test]
fn resumed_call_does_not_claim_an_identical_historical_child() {
    let data = DataRoot::new();
    data.transcript(PARENT, &spawn_step(2, "same task"));
    data.child(OLD, 2, "OLD RESULT");
    let mut subagents = Subagents::new(data.path());
    subagents.resume(PARENT, false);
    subagents
        .apply(PARENT, &invocation("new-call", "same task", "in_progress"))
        .unwrap();
    assert!(subagents.poll().is_empty());
    assert!(subagents.child_ids().is_empty());
    assert!(subagents.has_running());

    let steps = [spawn_step(2, "same task"), spawn_step(5, "same task")].concat();
    data.transcript(PARENT, &steps);
    data.child(NEW, 5, "NEW RESULT");
    let events = subagents.poll();
    assert_eq!(subagents.child_ids(), [NEW]);
    assert!(events.iter().any(|event| matches!(event, SessionEventBody::Subagent(card)
        if card.subagent_id == "new-call" && card.result == "NEW RESULT" && card.status == SubagentStatus::Completed)));
}

#[test]
fn same_role_calls_bind_by_their_spawn_step_and_input() {
    let data = DataRoot::new();
    data.transcript(
        PARENT,
        &[spawn_step(2, "first task"), spawn_step(4, "second task")].concat(),
    );
    // 文件枚举顺序和调用顺序无关。
    data.child(OLD, 4, "SECOND");
    data.child(NEW, 2, "FIRST");
    let mut subagents = Subagents::new(data.path());
    subagents
        .apply(
            PARENT,
            &invocation("second-call", "second task", "in_progress"),
        )
        .unwrap();
    subagents
        .apply(
            PARENT,
            &invocation("first-call", "first task", "in_progress"),
        )
        .unwrap();
    let events = subagents.poll();
    for (id, answer) in [("first-call", "FIRST"), ("second-call", "SECOND")] {
        assert!(events
            .iter()
            .any(|event| matches!(event, SessionEventBody::Subagent(card)
            if card.subagent_id == id && card.result == answer)));
    }
}

#[test]
fn replay_still_loads_historical_children_in_spawn_order() {
    let data = DataRoot::new();
    data.transcript(
        PARENT,
        &[spawn_step(2, "same task"), spawn_step(4, "same task")].concat(),
    );
    data.child(OLD, 4, "SECOND");
    data.child(NEW, 2, "FIRST");
    let mut subagents = Subagents::new(data.path());
    subagents.resume(PARENT, true);
    for (id, answer) in [("replay-1", "FIRST"), ("replay-2", "SECOND")] {
        let events = subagents
            .apply(PARENT, &invocation(id, "same task", "completed"))
            .unwrap();
        assert!(events
            .iter()
            .any(|event| matches!(event, SessionEventBody::Subagent(card)
            if card.subagent_id == id && card.result == answer)));
    }
}

#[test]
fn a_missing_child_record_does_not_shift_identical_calls() {
    let data = DataRoot::new();
    data.transcript(
        PARENT,
        &[spawn_step(2, "same task"), spawn_step(4, "same task")].concat(),
    );
    data.child(NEW, 4, "SECOND");
    let mut subagents = Subagents::new(data.path());
    subagents
        .apply(PARENT, &invocation("first", "same task", "in_progress"))
        .unwrap();
    subagents
        .apply(PARENT, &invocation("second", "same task", "in_progress"))
        .unwrap();
    let events = subagents.poll();
    assert!(events
        .iter()
        .any(|event| matches!(event, SessionEventBody::Subagent(card)
        if card.subagent_id == "second" && card.result == "SECOND")));
    assert!(!events
        .iter()
        .any(|event| matches!(event, SessionEventBody::Subagent(card)
        if card.subagent_id == "first" && card.status == SubagentStatus::Completed)));
    data.child(OLD, 2, "FIRST");
    let events = subagents.poll();
    assert!(events
        .iter()
        .any(|event| matches!(event, SessionEventBody::Subagent(card)
        if card.subagent_id == "first" && card.result == "FIRST")));
}

fn goal(objective: Option<&str>, status: &str) -> SessionEventBody {
    SessionEventBody::Goal {
        objective: objective.map(str::to_string),
        status: Some(status.to_string()),
        token_budget: None,
        tokens_used: None,
        time_used_seconds: None,
    }
}

struct Harness {
    shared: Arc<Shared>,
    dialect: Arc<AntigravityDialect>,
    session: AcpSession,
    wire: mpsc::UnboundedReceiver<String>,
    events: mpsc::UnboundedReceiver<SessionEventBody>,
}

impl Harness {
    fn new(project: &Path) -> Self {
        let (events, rx) = mpsc::unbounded_channel();
        let (tx, wire) = mpsc::unbounded_channel();
        let dialect = Arc::new(AntigravityDialect::new(
            project,
            events.clone(),
            false,
            json!([]),
        ));
        let shared = Shared::detached(
            Parts {
                dialect: dialect.clone(),
                events,
                project: project.into(),
                access: "full".into(),
                catalog: catalog::empty_catalog(),
                instructions: None,
                roots: vec![],
            },
            tx,
        );
        shared.adopt_session_id(PARENT);
        Self {
            session: AcpSession::new(shared.clone()),
            shared,
            dialect,
            wire,
            events: rx,
        }
    }

    fn drain(&mut self) -> Vec<SessionEventBody> {
        let mut events = Vec::new();
        while let Ok(event) = self.events.try_recv() {
            events.push(event);
        }
        events
    }
}

#[tokio::test]
async fn restored_goals_can_resume_without_submitting_on_open() {
    let data = DataRoot::new();
    let mut h = Harness::new(data.path());
    for (saved, expected) in [
        ("active", "paused"),
        ("paused", "paused"),
        ("complete", "complete"),
    ] {
        h.dialect.restore_goal(Some(goal(Some("finish it"), saved)));
        h.session.publish_goal().await.unwrap();
        assert!(h.drain().iter().all(
            |event| matches!(event, SessionEventBody::Goal { objective, status, .. }
            if objective.as_deref() == Some("finish it") && status.as_deref() == Some(expected))
        ));
        assert!(h.wire.try_recv().is_err(), "恢复不能自动投递目标");
    }
    h.session.set_goal_status("active").await.unwrap();
    let request: Value = serde_json::from_str(&h.wire.recv().await.unwrap()).unwrap();
    assert_eq!(request["method"], "session/prompt");
    assert_eq!(request["params"]["prompt"][0]["text"], "/goal finish it");
    h.shared.rpc.resolve(
        request["id"].as_u64().unwrap(),
        Ok(json!({"stopReason":"end_turn"})),
    );
    tokio::task::yield_now().await;
    h.session.clear_goal().await.unwrap();
    h.dialect.restore_goal(Some(goal(None, "paused")));
    assert!(h.session.set_goal_status("active").await.is_err());
}

#[tokio::test(start_paused = true)]
async fn long_background_tasks_keep_the_turn_running_and_can_be_stopped() {
    for stop in [false, true] {
        let data = DataRoot::new();
        let started = json!({"type":"GENERIC","status":"RUNNING","content":
            "Tool is running as a background task with task id: task-1\nTask Description: slow command"});
        let reply = json!({"type":"PLANNER_RESPONSE","content":"Waiting for the command."});
        data.transcript(PARENT, &[started.clone(), reply.clone()]);
        let mut h = Harness::new(data.path());
        h.session
            .deliver(UserTurn {
                text: "run it".into(),
                images: vec![],
                client_id: String::new(),
                annotations: vec![],
            })
            .await
            .unwrap();
        let request: Value = serde_json::from_str(&h.wire.recv().await.unwrap()).unwrap();
        h.shared.on_update(&json!({"sessionId":PARENT,"update":{
            "sessionUpdate":"tool_call","toolCallId":"bg","kind":"execute","name":"run_command",
            "status":"in_progress","rawInput":{"CommandLine":"slow command"}}}));
        h.shared.rpc.resolve(
            request["id"].as_u64().unwrap(),
            Ok(json!({"stopReason":"end_turn"})),
        );
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(120)).await;
        tokio::task::yield_now().await;
        assert!(!h.drain().iter().any(|event| matches!(
            event,
            SessionEventBody::StatusChanged {
                status: SessionStatus::Completed
            }
        )));
        if stop {
            h.session.interrupt().await.unwrap();
        } else {
            let finished = json!({"type":"SYSTEM_MESSAGE","content":
                "[Message] sender=task-1 content=Task id \"task-1\" finished with result:\nCommand exited with code 0.\n\nCommand output:\nDONE"});
            let answer = json!({"type":"PLANNER_RESPONSE","content":"The command finished: DONE."});
            data.transcript(PARENT, &[started, reply, finished, answer]);
        }
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        let events = h.drain();
        let expected = if stop {
            SessionStatus::Stopped
        } else {
            SessionStatus::Completed
        };
        assert!(events.iter().any(|event| matches!(event, SessionEventBody::StatusChanged { status } if *status == expected)), "{events:#?}");
        if !stop {
            assert!(events.iter().any(|event| matches!(event, SessionEventBody::ToolCall { status:ToolStatus::Completed, detail, .. } if detail == "DONE")));
            assert!(events.iter().any(|event| matches!(event, SessionEventBody::AgentMessage { text, .. } if text.contains("finished: DONE"))));
        }
    }
}
