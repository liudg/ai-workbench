//! Codex 的后台终端 → `BackgroundTask`。
//!
//! 2026-11-17 codex-cli 0.169.0 实测：模型用很短的 yield 起命令时，`commandExecution` 条目在 `turn/completed` 之后
//! 仍是 `inProgress`，`thread/backgroundTerminals/list` 列出它（`itemId`、`processId`、`command`）。进程退出后才补一条
//! 该条目的 `item/completed`，这时没有回合在跑，模型也不会被叫醒。`thread/backgroundTerminals/terminate` 停掉的，
//! 补的那条是 `failed`、`exitCode: -1`；`/stop` 的 `thread/backgroundTerminals/clean` 一次停掉全部，每个也都补一条 `item/completed`。
//!
//! 通知按顺序到，回合结束时还开着、带 `processId` 的命令条目就是后台终端，不另外调 `list`。
//! 回合被打断（`interrupted`）时也一样：正在跑的命令不会被杀，`list` 里照样有它。
//! 输出在对应的工具卡片上，任务不再存一份。

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use aiwb_core::models::{now_millis, BackgroundTask, BackgroundTaskStatus, SessionEventBody, ToolStatus};

use super::history::item_status;
use super::state::{emit, Shared};
use crate::protocol::text;
use crate::AgentError;

/// 原生没有给后台终端分种类，这里统一叫 `terminal`。
const KIND: &str = "terminal";

/// 一条还没结束的命令条目。
pub(super) struct OpenCommand {
    process_id: String,
    command: String,
}

#[derive(Default)]
pub(super) struct Terminals {
    /// 本线程还开着的命令条目，按 item id。
    open: HashMap<String, OpenCommand>,
    /// 后台终端，按 `processId`。
    tasks: HashMap<String, BackgroundTask>,
    /// 宿主要求停掉、还没收到结束条目的 `processId`。结束时记成已停止，不算失败。
    stopping: HashSet<String>,
}

impl Shared {
    /// 本线程的 `commandExecution` 条目开始或结束。结束的若是后台终端，任务跟着结束。
    pub(super) fn note_command_item(&self, completed: bool, item: &Value) {
        if item.get("type").and_then(Value::as_str) != Some("commandExecution") {
            return;
        }
        let Some(id) = text(item, "id") else {
            return;
        };
        let mut guard = self.terminals.lock().unwrap();
        let terminals = &mut *guard;
        if !completed {
            if let Some(process_id) = text(item, "processId") {
                let command = text(item, "command").unwrap_or_default();
                terminals.open.insert(id, OpenCommand { process_id, command });
            }
            return;
        }
        // 回合里就结束的命令条目不是后台终端。
        if terminals.open.remove(&id).is_some() {
            return;
        }
        let Some(task) = terminals
            .tasks
            .values_mut()
            .find(|task| task.running() && task.tool_call_id.as_deref() == Some(id.as_str()))
        else {
            return;
        };
        task.exit_code = item.get("exitCode").and_then(Value::as_i64);
        // 成败和工具卡片用同一套判断。要求停止时恰好自己退出的照原生结果记：成功是完成，带退出码失败是失败。
        // 停掉的终端补的是 `exitCode: -1`（`clean` 不一定给退出码），只有这样的才算被停掉。
        let stopping = terminals.stopping.remove(&task.task_id);
        let killed = matches!(task.exit_code, None | Some(-1));
        let status = if item_status(item, task.exit_code) == ToolStatus::Completed {
            BackgroundTaskStatus::Completed
        } else if stopping && killed {
            BackgroundTaskStatus::Stopped
        } else {
            BackgroundTaskStatus::Failed
        };
        let at = item.get("completedAtMs").and_then(Value::as_i64).or_else(|| Some(now_millis()));
        task.finish(status, at);
        emit(&self.events, SessionEventBody::BackgroundTask(task.clone()));
    }

    /// 回合结束：还开着的命令条目留在后台跑。
    pub(super) fn adopt_background_terminals(&self) {
        let mut terminals = self.terminals.lock().unwrap();
        let open: Vec<(String, OpenCommand)> = terminals.open.drain().collect();
        let now = Some(now_millis());
        for (item_id, command) in open {
            // 和工具卡片的摘要一样用条目里的 `command`。
            let mut task = BackgroundTask::new(&command.process_id, KIND, command.command);
            task.tool_call_id = Some(item_id);
            task.started_at = now;
            terminals.tasks.insert(command.process_id, task.clone());
            emit(&self.events, SessionEventBody::BackgroundTask(task));
        }
    }

    /// `thread/backgroundTerminals/terminate`。任务等结束条目到了才算停下。
    pub(super) async fn stop_background_task(&self, task_id: &str) -> Result<(), AgentError> {
        self.ensure_open()?;
        if !self.terminals.lock().unwrap().tasks.get(task_id).is_some_and(BackgroundTask::running) {
            return Err(AgentError::Runtime("这个后台任务没有在跑".into()));
        }
        let thread_id = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| AgentError::Runtime("Codex 线程未建立".into()))?;
        self.terminals.lock().unwrap().stopping.insert(task_id.to_string());
        let result = self
            .request("thread/backgroundTerminals/terminate", json!({ "threadId": thread_id, "processId": task_id }))
            .await
            .and_then(|value| match value.get("terminated").and_then(Value::as_bool) {
                Some(true) => Ok(()),
                // 回包前它自己退出了：停止没生效，结束条目已经按原生结果记下。
                _ if !self.terminals.lock().unwrap().tasks.get(task_id).is_some_and(BackgroundTask::running) => {
                    Err(AgentError::Runtime("这个后台终端在停止前已经自己结束了".into()))
                }
                _ => Err(AgentError::Runtime("Codex 没有停掉这个后台终端".into())),
            });
        if result.is_err() {
            self.unmark_stopping(&[task_id.to_string()]);
        }
        result
    }

    /// `/stop` 停掉全部后台终端：随后到的结束条目都记成已停止。返回记下的 `processId`。
    pub(super) fn note_terminals_cleaning(&self) -> Vec<String> {
        let mut terminals = self.terminals.lock().unwrap();
        let running: Vec<String> =
            terminals.tasks.iter().filter(|(_, task)| task.running()).map(|(id, _)| id.clone()).collect();
        terminals.stopping.extend(running.iter().cloned());
        running
    }

    /// 停止请求没成：这些终端结束时仍按它自己的结果记。
    pub(super) fn unmark_stopping(&self, process_ids: &[String]) {
        self.terminals.lock().unwrap().stopping.retain(|pending| !process_ids.contains(pending));
    }

    /// 进程没了，后台终端也跟着没了。
    pub(super) fn stop_background(&self) {
        let mut terminals = self.terminals.lock().unwrap();
        terminals.open.clear();
        terminals.stopping.clear();
        for event in BackgroundTask::stop_all(terminals.tasks.values_mut()) {
            emit(&self.events, event);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::{json, Value};
    use tokio::sync::mpsc;

    use aiwb_core::models::{BackgroundTask, BackgroundTaskStatus, SessionEventBody};

    use super::super::state::Shared;

    const ITEM: &str = "exec-78c1";

    /// 报文照 codex-cli 0.169.0（2026-11-17）实录，去掉了无关字段。
    fn command(status: &str, exit: Value) -> Value {
        json!({ "threadId": "thr_1", "turnId": "turn_1", "item": {
            "type": "commandExecution", "id": ITEM, "processId": "78219", "source": "unifiedExecStartup",
            "command": "\"powershell.exe\" -Command 'Start-Sleep -Seconds 30; Write-Output finished-marker'",
            "status": status, "exitCode": exit, "completedAtMs": 1794913582000_i64,
        }})
    }

    fn harness() -> (Arc<Shared>, mpsc::UnboundedReceiver<String>, mpsc::UnboundedReceiver<SessionEventBody>) {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let shared = Arc::new(Shared::for_test(events_tx, out_tx));
        *shared.thread_id.lock().unwrap() = Some("thr_1".into());
        (shared, out_rx, events_rx)
    }

    fn tasks(events: &mut mpsc::UnboundedReceiver<SessionEventBody>) -> Vec<BackgroundTask> {
        let mut tasks = Vec::new();
        while let Ok(body) = events.try_recv() {
            if let SessionEventBody::BackgroundTask(task) = body {
                tasks.push(task);
            }
        }
        tasks
    }

    fn turn_completed(shared: &Shared) {
        shared.handle_notification("turn/completed", &json!({ "threadId": "thr_1", "turn": { "id": "turn_1", "status": "completed" } }));
    }

    /// 回合结束时还开着的命令留在后台；进程退出后补来的 `item/completed` 让它结束，退出码照记。
    #[test]
    fn open_command_at_turn_end_runs_in_the_background() {
        let (shared, _out, mut events) = harness();
        shared.handle_notification("item/started", &command("inProgress", Value::Null));
        assert!(tasks(&mut events).is_empty(), "回合还在跑时不是后台任务");
        turn_completed(&shared);
        let started = tasks(&mut events);
        assert_eq!(started.len(), 1);
        let task = &started[0];
        assert_eq!((task.task_id.as_str(), task.task_type.as_str()), ("78219", "terminal"));
        assert_eq!(task.tool_call_id.as_deref(), Some(ITEM));
        assert!(task.title.contains("Start-Sleep -Seconds 30"));
        assert!(task.running());

        shared.handle_notification("item/completed", &command("completed", json!(0)));
        let done = tasks(&mut events);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].status, BackgroundTaskStatus::Completed);
        assert_eq!(done[0].exit_code, Some(0));
        assert_eq!(done[0].ended_at, Some(1794913582000));
    }

    /// 回合里跑完的命令不是后台任务。
    #[test]
    fn command_finished_in_the_turn_is_not_background() {
        let (shared, _out, mut events) = harness();
        shared.handle_notification("item/started", &command("inProgress", Value::Null));
        shared.handle_notification("item/completed", &command("completed", json!(0)));
        turn_completed(&shared);
        assert!(tasks(&mut events).is_empty());
    }

    /// 宿主停掉的：`terminate` 回 `terminated: true`，补来的 `failed`、`exitCode: -1` 记成已停止。
    #[tokio::test]
    async fn terminate_stops_the_terminal() {
        let (shared, mut out, mut events) = harness();
        shared.handle_notification("item/started", &command("inProgress", Value::Null));
        turn_completed(&shared);
        tasks(&mut events);
        let stopping = {
            let shared = shared.clone();
            tokio::spawn(async move { shared.stop_background_task("78219").await })
        };
        let line = out.recv().await.expect("terminate line");
        let request: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["method"], "thread/backgroundTerminals/terminate");
        assert_eq!(request["params"], json!({ "threadId": "thr_1", "processId": "78219" }));
        shared.handle_line(&json!({ "jsonrpc": "2.0", "id": request["id"], "result": { "terminated": true } }).to_string());
        stopping.await.unwrap().unwrap();
        shared.handle_notification("item/completed", &command("failed", json!(-1)));
        let done = tasks(&mut events);
        assert_eq!(done[0].status, BackgroundTaskStatus::Stopped);
        assert_eq!(done[0].exit_code, Some(-1));
        assert!(shared.stop_background_task("78219").await.is_err(), "已经停了");
    }

    /// 要求停止时它恰好自己退出：照原生结果记（成功是完成，退出码 1 是失败），`terminate` 回 `false` 时报停止没生效。
    #[tokio::test]
    async fn terminal_that_exits_while_stopping_keeps_its_own_result() {
        for (status, exit, expected) in [
            ("completed", 0, BackgroundTaskStatus::Completed),
            ("failed", 1, BackgroundTaskStatus::Failed),
        ] {
            let (shared, mut out, mut events) = harness();
            shared.handle_notification("item/started", &command("inProgress", Value::Null));
            turn_completed(&shared);
            tasks(&mut events);
            let stopping = {
                let shared = shared.clone();
                tokio::spawn(async move { shared.stop_background_task("78219").await })
            };
            let line = out.recv().await.expect("terminate line");
            let request: Value = serde_json::from_str(&line).unwrap();
            shared.handle_notification("item/completed", &command(status, json!(exit)));
            shared.handle_line(&json!({ "jsonrpc": "2.0", "id": request["id"], "result": { "terminated": false } }).to_string());
            let err = stopping.await.unwrap().expect_err("停止没生效");
            assert!(err.to_string().contains("已经自己结束"), "{err}");
            let done = tasks(&mut events);
            assert_eq!((done[0].status, done[0].exit_code), (expected, Some(exit)));
        }
    }

    /// 自己失败退出的记成失败。
    #[test]
    fn terminal_that_fails_on_its_own_is_failed() {
        let (shared, _out, mut events) = harness();
        shared.handle_notification("item/started", &command("inProgress", Value::Null));
        turn_completed(&shared);
        tasks(&mut events);
        shared.handle_notification("item/completed", &command("failed", json!(1)));
        assert_eq!(tasks(&mut events)[0].status, BackgroundTaskStatus::Failed);
    }

    /// 进程退出：还在跑的后台终端记成已停止。
    #[test]
    fn exit_stops_running_terminals() {
        let (shared, _out, mut events) = harness();
        shared.handle_notification("item/started", &command("inProgress", Value::Null));
        turn_completed(&shared);
        tasks(&mut events);
        shared.on_exit();
        let stopped = tasks(&mut events);
        assert_eq!(stopped.len(), 1);
        assert_eq!(stopped[0].status, BackgroundTaskStatus::Stopped);
    }
}
