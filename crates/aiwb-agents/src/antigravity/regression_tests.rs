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
use aiwb_core::models::{BackgroundTask, BackgroundTaskStatus, SessionEventBody, SessionStatus, SubagentStatus, ToolStatus};

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
        // agy 在回合里才写转录：回合开始之后。
        data.transcript(PARENT, &[started.clone(), reply.clone()]);
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

impl Harness {
    /// 投一轮：发出 `session/prompt` 后写好这一轮的转录（agy 在回合里才写），画这些命令卡片（工具调用 id、命令），
    /// 再回包 `end_turn`。
    async fn turn(&mut self, data: &DataRoot, transcript: &[Value], cards: &[(&str, &str)]) {
        while self.wire.try_recv().is_ok() {}
        self.session
            .deliver(UserTurn { text: "go".into(), images: vec![], client_id: String::new(), annotations: vec![] })
            .await
            .unwrap();
        let request = loop {
            let request: Value = serde_json::from_str(&self.wire.recv().await.unwrap()).unwrap();
            if request["method"] == "session/prompt" {
                break request;
            }
        };
        data.transcript(PARENT, transcript);
        for (id, command) in cards {
            self.shared.on_update(&json!({"sessionId":PARENT,"update":{
                "sessionUpdate":"tool_call","toolCallId":id,"kind":"execute","name":"run_command",
                "status":"in_progress","rawInput":{"CommandLine":command}}}));
        }
        self.shared.rpc.resolve(request["id"].as_u64().unwrap(), Ok(json!({"stopReason":"end_turn"})));
        tick().await;
    }
}

/// 让等待循环转几圈。
async fn tick() {
    for _ in 0..5 {
        tokio::time::advance(Duration::from_millis(400)).await;
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }
}

fn task_started(id: &str, command: &str) -> Value {
    json!({"type":"GENERIC","status":"RUNNING","content":
        format!("Tool is running as a background task with task id: {id}\nTask Description: {command}")})
}

fn task_finished(id: &str, code: i64, output: &str) -> Value {
    json!({"type":"SYSTEM_MESSAGE","content":format!(
        "[Message] sender={id} content=Task id \"{id}\" finished with result:\nCommand exited with code {code}.\n\nCommand output:\n{output}")})
}

/// 照 agy 1.5.10 实录（2026-11-17）：取消的任务只有一个换行就是 `Log:`。
fn task_canceled(id: &str) -> Value {
    json!({"type":"SYSTEM_MESSAGE","content":format!(
        "<SYSTEM_MESSAGE>\n[Message] timestamp=t sender={id} priority=MESSAGE_PRIORITY_LOW content=Task id \"{id}\" was canceled with result:\nTool execution was canceled\nLog: file:///x/{id}.log\n</SYSTEM_MESSAGE>")})
}

fn reply(text: &str) -> Value {
    json!({"type":"PLANNER_RESPONSE","content":text})
}

fn background_tasks(events: &[SessionEventBody]) -> Vec<BackgroundTask> {
    events
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::BackgroundTask(task) => Some(task.clone()),
            _ => None,
        })
        .collect()
}

fn completed(events: &[SessionEventBody]) -> bool {
    events.iter().any(|event| matches!(event, SessionEventBody::StatusChanged { status: SessionStatus::Completed }))
}

/// 整轮停掉时记成已停止的任务，转录里永远等不到结束消息。下一轮从头重读转录时不能再等它。
#[tokio::test(start_paused = true)]
async fn a_stopped_background_task_does_not_hold_the_next_turn() {
    let data = DataRoot::new();
    let started = task_started("task-1", "slow command");
    let waiting = reply("Waiting for the command.");
    let mut h = Harness::new(data.path());
    h.turn(&data, &[started.clone(), waiting.clone()], &[("bg", "slow command")]).await;
    h.session.interrupt().await.unwrap();
    tick().await;
    let tasks = background_tasks(&h.drain());
    assert_eq!(tasks.last().map(|task| task.status), Some(BackgroundTaskStatus::Stopped), "{tasks:#?}");

    h.turn(&data, &[started, waiting, reply("NEXT-OK")], &[]).await;
    let events = h.drain();
    assert!(completed(&events), "{events:#?}");
}

/// 重新打开会话（新进程，没有登记过任何任务）：旧转录里只有启动记录的任务是上一个进程的，第一轮不等它。
#[tokio::test(start_paused = true)]
async fn a_reopened_session_does_not_wait_for_the_old_process_tasks() {
    let data = DataRoot::new();
    let old = [task_started("task-1", "slow command"), reply("Waiting for the command.")];
    data.transcript(PARENT, &old);
    let mut h = Harness::new(data.path());
    let mut steps = old.to_vec();
    steps.push(reply("NEXT-OK"));
    h.turn(&data, &steps, &[]).await;
    let events = h.drain();
    assert!(completed(&events), "{events:#?}");
    assert!(background_tasks(&events).is_empty(), "旧任务不登记：{events:#?}");
}

/// 等待时 agy 把任务取消了（`was canceled with result:`）：记成已停止、卡片收尾，回合照常结束。
#[tokio::test(start_paused = true)]
async fn a_task_canceled_by_agy_while_waiting_ends_the_wait() {
    let data = DataRoot::new();
    let started = task_started("task-1", "slow command");
    let waiting = reply("Waiting for the command.");
    let mut h = Harness::new(data.path());
    h.turn(&data, &[started.clone(), waiting.clone()], &[("bg", "slow command")]).await;
    assert!(!completed(&h.drain()));

    data.transcript(PARENT, &[started, waiting, task_canceled("task-1"), reply("The command was canceled.")]);
    tick().await;
    let events = h.drain();
    let tasks = background_tasks(&events);
    let task = tasks.last().expect("任务要收尾");
    assert_eq!((task.status, task.result.as_str()), (BackgroundTaskStatus::Stopped, "Tool execution was canceled"));
    assert!(events.iter().any(|event| matches!(event,
        SessionEventBody::ToolCall { stream_id: Some(id), status: ToolStatus::Failed, .. } if id == "tool-bg")));
    assert!(completed(&events), "{events:#?}");
}

/// `session/prompt` 回包前就跑完的本轮任务：第一次从头读转录时登记并收尾，退出码和结果不丢。
#[tokio::test(start_paused = true)]
async fn a_task_that_finished_before_the_reply_is_recorded() {
    let data = DataRoot::new();
    let mut h = Harness::new(data.path());
    let steps = [
        task_started("task-1", "quick command"),
        reply("Waiting for the command."),
        task_finished("task-1", 2, "oops"),
        reply("It failed."),
    ];
    h.turn(&data, &steps, &[("bg", "quick command")]).await;
    let events = h.drain();
    let tasks = background_tasks(&events);
    assert_eq!(tasks.len(), 1, "{tasks:#?}");
    assert_eq!((tasks[0].status, tasks[0].exit_code), (BackgroundTaskStatus::Failed, Some(2)));
    assert_eq!(tasks[0].tool_call_id.as_deref(), Some("tool-bg"));
    assert!(completed(&events), "{events:#?}");
}

/// 两次读取之间启动又结束的任务也要记下，连同退出码和它的命令卡片。
#[tokio::test(start_paused = true)]
async fn a_background_task_that_starts_and_ends_between_reads_is_recorded() {
    let data = DataRoot::new();
    let slow = task_started("task-1", "slow command");
    let waiting = reply("Waiting for the command.");
    let mut h = Harness::new(data.path());
    h.turn(&data, &[slow.clone(), waiting.clone()], &[("bg1", "slow command"), ("bg2", "quick command")]).await;
    let tasks = background_tasks(&h.drain());
    assert_eq!(tasks.iter().map(|task| task.task_id.as_str()).collect::<Vec<_>>(), ["task-1"]);

    data.transcript(PARENT, &[
        slow,
        waiting,
        task_started("task-2", "quick command"),
        task_finished("task-2", 3, "boom"),
        task_finished("task-1", 0, "DONE"),
        reply("All done."),
    ]);
    tick().await;
    let events = h.drain();
    let tasks = background_tasks(&events);
    let quick = tasks.iter().find(|task| task.task_id == "task-2").expect("task-2 要记下");
    assert_eq!((quick.status, quick.exit_code), (BackgroundTaskStatus::Failed, Some(3)));
    assert_eq!(quick.tool_call_id.as_deref(), Some("tool-bg2"));
    let slow = tasks.iter().find(|task| task.task_id == "task-1").unwrap();
    assert_eq!((slow.status, slow.tool_call_id.as_deref()), (BackgroundTaskStatus::Completed, Some("tool-bg1")));
    assert!(events.iter().any(|event| matches!(event,
        SessionEventBody::ToolCall { stream_id: Some(id), status: ToolStatus::Failed, detail, .. } if id == "tool-bg2" && detail == "boom")));
    assert!(events.iter().any(|event| matches!(event,
        SessionEventBody::ToolCall { stream_id: Some(id), status: ToolStatus::Completed, detail, .. } if id == "tool-bg1" && detail == "DONE")));
    assert!(completed(&events));
}

/// 同一条命令起了两次，同一批读到「第一条已结束、第二条还在跑」：卡片按启动先后分，结果写回各自的卡片。
#[tokio::test(start_paused = true)]
async fn identical_commands_keep_their_cards_in_start_order() {
    for round in 0..8 {
        let data = DataRoot::new();
        let mut h = Harness::new(data.path());
        let steps = [
            task_started("task-a", "npm run dev"),
            task_started("task-b", "npm run dev"),
            task_finished("task-a", 1, "first failed"),
            reply("Waiting for the second one."),
        ];
        h.turn(&data, &steps, &[("first", "npm run dev"), ("second", "npm run dev")]).await;
        let events = h.drain();
        let tasks = background_tasks(&events);
        let card = |id: &str| tasks.iter().rev().find(|task| task.task_id == id).and_then(|task| task.tool_call_id.clone());
        assert_eq!(card("task-a").as_deref(), Some("tool-first"), "第 {round} 次：{tasks:#?}");
        assert_eq!(card("task-b").as_deref(), Some("tool-second"), "第 {round} 次：{tasks:#?}");
        assert!(events.iter().any(|event| matches!(event,
            SessionEventBody::ToolCall { stream_id: Some(id), status: ToolStatus::Failed, detail, .. } if id == "tool-first" && detail == "first failed")));
    }
}
