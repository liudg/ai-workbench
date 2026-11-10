//! Cursor Agent 在 ACP 之上的差别：扩展请求（提问、计划、待办、生成图、子 Agent）和结果形状。
//!
//! 对照本机 Cursor Agent 2026.10.22-27dcf5f 的 `3635.index.js` 和 2026-10-29 的实际收发：
//! - `tool_call` 先报 `pending` 和空 `rawInput`，`tool_call_update` 再补标题、输入、状态和结果。
//! - 命令结果在 `rawOutput.exitCode/stdout/stderr`。
//! - 新建文件的 diff 是 `oldText = "-- /dev/null"`，`newText` 首行带 `++ b/<路径>`。
//! - 回放里工具 id 是 `replay-<回合>-<序号>`。
//! - 后端出错时 Cursor 不报错，而是发一段 `\n\nError: …` 的回答文字，`session/prompt` 照常 `end_turn`
//!   （`agent-session.ts` 的 ``sendAgentMessageChunk(`\n\nError: ${String(e)}`)``）。

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::permission;
use super::prompts::{self, Pending};
use super::subagents::Subagents;
use crate::acp::runtime::Shared;
use crate::acp::{Dialect, DiffTexts, ToolSubject, UpdateRules};
use aiwb_core::models::{AgentCatalog, PermissionMenu, SessionEventBody};

pub struct CursorRules;

pub static RULES: CursorRules = CursorRules;

/// Cursor 把后端异常当回答文字发出时的开头。
const ERROR_TAIL: &str = "\n\nError: ";

impl UpdateRules for CursorRules {
    fn error_tail(&self) -> &'static str {
        ERROR_TAIL
    }

    fn error_message(&self, detail: &str) -> String {
        format!("Cursor 后端出错：{detail}")
    }

    /// `oldText` 为 null 或 Cursor 的 `-- /dev/null` 表示新建；
    /// `newText` 首行 `++ b/<路径>` 是 Cursor 带上的文件头，不是正文。
    fn diff_texts(&self, item: &Value) -> Option<DiffTexts> {
        let path = item.get("path").and_then(Value::as_str)?.trim().to_string();
        if path.is_empty() {
            return None;
        }
        let old = item
            .get("oldText")
            .and_then(Value::as_str)
            .filter(|text| text.trim() != "-- /dev/null")
            .map(str::to_string);
        let new = match item.get("newText").and_then(Value::as_str) {
            Some(text) if text.trim() == "++ /dev/null" => None,
            Some(text) if text.starts_with("++ ") => {
                Some(text.split_once('\n').map(|(_, rest)| rest).unwrap_or("").to_string())
            }
            Some(text) => Some(text.to_string()),
            None => None,
        };
        let new = if old.is_none() {
            new.map(|text| ensure_trailing_newline(&text))
        } else {
            new
        };
        Some(DiffTexts { path, old, new })
    }

    fn tool_subject(&self, kind: &str, input: &Value) -> Option<ToolSubject> {
        let field = |keys: &[&str]| {
            keys.iter()
                .find_map(|key| input.get(*key).and_then(Value::as_str))
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        };
        match kind {
            "execute" => field(&["command"]).map(ToolSubject::Text),
            "edit" | "read" | "delete" | "move" => {
                field(&["path", "file_path", "filePath"]).map(ToolSubject::Path)
            }
            "search" => field(&["pattern", "query", "searchTerm", "glob"]).map(ToolSubject::Text),
            "fetch" => field(&["url"]).map(ToolSubject::Text),
            _ => None,
        }
    }
}

fn ensure_trailing_newline(text: &str) -> String {
    if text.is_empty() || text.ends_with('\n') {
        text.to_string()
    } else {
        format!("{text}\n")
    }
}

pub struct CursorDialect {
    subagents: Mutex<Subagents>,
}

impl CursorDialect {
    pub fn new(project: &std::path::Path) -> Self {
        Self {
            subagents: Mutex::new(Subagents::new(project)),
        }
    }
}

impl Dialect for CursorDialect {
    fn label(&self) -> &'static str {
        "Cursor Agent"
    }

    fn rules(&self) -> &'static dyn UpdateRules {
        &RULES
    }

    fn not_logged_in(&self) -> String {
        "Cursor Agent 还没有登录。请在终端运行 `agent login` 后再试。".into()
    }

    fn access_level(&self, mode: &str) -> &'static str {
        if mode == "full" {
            "full"
        } else {
            "ask"
        }
    }

    fn permission_menu(&self, active: &str) -> PermissionMenu {
        permission::permission_menu(active)
    }

    fn mode_id(&self, plan: bool, _access: &str) -> &'static str {
        if plan {
            "plan"
        } else {
            "agent"
        }
    }

    fn asks_user(&self, method: &str) -> bool {
        matches!(method, "session/request_permission" | "cursor/ask_question" | "cursor/create_plan")
    }

    fn workbench_tool(&self, params: &Value) -> bool {
        prompts::workbench_tool(params)
    }

    fn adopt_session(&self, _catalog: &mut AgentCatalog, _payload: &Value) {}

    fn on_update(&self, session: &str, update: &Value) -> Option<Vec<SessionEventBody>> {
        self.subagents.lock().unwrap().apply(session, update)
    }

    fn stop_extras(&self) -> Vec<SessionEventBody> {
        self.subagents.lock().unwrap().stop_all()
    }

    fn on_request(&self, shared: &Shared, id: &Value, method: &str, params: &Value) -> bool {
        match method {
            "cursor/ask_question" => {
                let prompt_id = prompts::prompt_id(id);
                let (event, pending) = prompts::question_prompt(&prompt_id, params);
                shared.raise(id.clone(), prompt_id, Arc::new(pending), vec![event]);
            }
            "cursor/create_plan" => {
                let prompt_id = prompts::prompt_id(id);
                let mut events = Vec::new();
                let text = prompts::plan_text(params);
                let tool = params.get("toolCallId").and_then(Value::as_str).unwrap_or("");
                if !text.is_empty() {
                    events.push(SessionEventBody::PlanText {
                        text,
                        stream_id: Some(format!("plan-{tool}")),
                        mode: Some("plan".into()),
                    });
                }
                if let Some(todos) = params.get("todos").filter(|todos| {
                    todos.as_array().is_some_and(|items| !items.is_empty())
                }) {
                    let mut map = shared.map.lock().unwrap();
                    map.set_todos(todos);
                    events.push(map.todo_steps());
                }
                let (event, pending) = prompts::plan_prompt(&prompt_id);
                events.push(event);
                shared.raise(id.clone(), prompt_id, Arc::new(pending), events);
            }
            "cursor/update_todos" => {
                let _ = shared.rpc.respond(id, json!({}));
                let events = shared.map.lock().unwrap().apply_todos(params);
                for event in events {
                    let _ = shared.events.send(event);
                }
            }
            "cursor/generate_image" => {
                let _ = shared.rpc.respond(id, json!({}));
                let events = shared.map.lock().unwrap().attach_image(params);
                for event in events {
                    let _ = shared.events.send(event);
                }
            }
            // 子 Agent 跑完：补上用时和模型。
            "cursor/task" => {
                let _ = shared.rpc.respond(id, json!({}));
                for event in self.subagents.lock().unwrap().task_done(params) {
                    let _ = shared.events.send(event);
                }
            }
            _ => return false,
        }
        true
    }
}

impl crate::acp::PendingAnswer for Pending {
    fn respond(&self, answer: &aiwb_core::models::PromptAnswer) -> Result<(Value, String), crate::AgentError> {
        prompts::response(self, answer)
    }

    fn settled(&self, shared: &Arc<Shared>, result: &Value) {
        if matches!(self, Pending::Plan) && prompts::plan_accepted(result) {
            // 采纳计划后回到 Agent 模式，下一条消息就能动手改。
            shared.wanted.lock().unwrap().plan = false;
            let _ = shared.events.send(SessionEventBody::CollaborationMode {
                mode: "default".into(),
            });
        }
    }
}
