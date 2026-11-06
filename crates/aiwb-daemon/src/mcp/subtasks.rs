//! 子任务工具：开、列、读、追加消息、打断。只认调用方任务下的子任务。
//! 规则在 `services::subtasks`，这里只把参数和结果转成 MCP 的样子。
//! 照 t3code `apps/server/src/mcp/toolkits/orchestrator/tools.ts`，工具描述里写明什么时候该用。

use aiwb_core::models::AgentKind;
use aiwb_core::task::Initiation;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::schemars::{self, JsonSchema};
use rmcp::{tool, tool_router};
use serde::Deserialize;
use serde_json::Value;

use super::server::WorkbenchServer;
use crate::services::{Caller, SubtaskRequest};

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum InitiationParam {
    UserAsked,
    Offer,
    OwnInitiative,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SubtaskParam {
    /// Short title shown in the sidebar.
    title: String,
    /// The subtask's first message. It does not see your conversation: say what to do, which files are involved, and what done looks like.
    prompt: String,
    /// Agent id from aiwb_capabilities. Defaults to your own agent.
    #[serde(default)]
    agent: Option<String>,
    /// Give the subtask its own git worktree (detached; it can create a branch there). Use it for subtasks that write code in parallel.
    #[serde(default)]
    worktree: bool,
    /// Model id from that agent's catalog in aiwb_capabilities. Omit for the agent's default.
    #[serde(default)]
    model: Option<String>,
    /// Reasoning effort from that model's list. Omit for the default.
    #[serde(default)]
    effort: Option<String>,
    /// Permission level: read-only, ask, approve-for-me or full. Defaults to yours; never wider than yours.
    #[serde(default)]
    access: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    /// Who wants this split off. See the tool description.
    initiation: InitiationParam,
    subtasks: Vec<SubtaskParam>,
    /// Optional id that makes retries safe: the same id returns the first result instead of opening again.
    #[serde(default)]
    client_request_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct TaskParam {
    task_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReadParams {
    task_id: String,
    /// Return items older than this seq (the previous page's nextBefore). Omit for the newest page.
    #[serde(default)]
    before: Option<u64>,
    /// Page size, 1–100. Defaults to 20.
    #[serde(default)]
    limit: Option<usize>,
    /// Also include progress notes, tool calls, prompts and errors.
    #[serde(default)]
    all: bool,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum SendMode {
    Auto,
    Steer,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SendParams {
    task_id: String,
    text: String,
    /// auto: if the subtask is mid-turn, follow its own setting (usually queued until the turn ends). steer: deliver into the running turn now.
    #[serde(default)]
    mode: Option<SendMode>,
    /// Optional id that makes retries safe.
    #[serde(default)]
    client_request_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct NoParams {}

type Reply = Result<String, String>;

fn json(value: impl serde::Serialize) -> Reply {
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

#[tool_router(router = subtask_tools, vis = "pub(super)")]
impl WorkbenchServer {
    #[tool(
        description = "List the agents you can give subtasks, with their models, reasoning efforts, permission levels and plan-mode support, plus your own agent, model, permission level and plan mode."
    )]
    async fn aiwb_capabilities(&self, caller: Caller, _: Parameters<NoParams>) -> Reply {
        json(self.services.subtask_capabilities(&caller)?)
    }

    #[tool(description = "Open one or more subtasks under your current task. Each subtask is a separate workbench task with a full agent session of its own: it may use a different agent and can get its own git worktree, and the user can open, steer or stop it from your timeline and the sidebar. The call returns at once; do not wait or poll. When all your subtasks have stopped and you are idle, the workbench sends you one message with their results.

This is the only way to have another agent (Codex, Claude, Cursor, …) do something: never run another agent's CLI (codex, claude, cursor-agent, agent, …) from the shell or a background command, since the user cannot see or steer that. Also use this, not your built-in subagents, when the user asks for a nested, separate or background session or task.

Prefer your own built-in subagents for other lightweight work. Open a subtask only when the work needs its own worktree, needs the user to be able to step in, or should be done by a different agent. Every subtask starts a full session and reloads context.

Subtasks do not see this conversation: write each prompt as a self-contained brief (what to do, which files, what done looks like).

initiation — declare it honestly from the user's words:
- user_asked: the user explicitly asked to split this off, run it separately or in the background, or start it now. Opens right away.
- offer: the user's latest message asks for this work but did not say to split it off. A card asks the user. End your turn right after this call; you will get a message with the user's choice (opened, or do it here yourself).
- own_initiative: work you noticed or propose that the user did not ask for. A card the user may start later; do not wait, continue your own work. At most 3 per turn, never the same thing twice. Never use it for work the user asked for.

A subtask inherits your permission level and plan mode and can never be wider than yours. Subtasks cannot open subtasks of their own.")]
    async fn aiwb_subtask_create(&self, caller: Caller, Parameters(params): Parameters<CreateParams>) -> Reply {
        let initiation = match params.initiation {
            InitiationParam::UserAsked => Initiation::UserAsked,
            InitiationParam::Offer => Initiation::Offer,
            InitiationParam::OwnInitiative => Initiation::OwnInitiative,
        };
        let requests = params
            .subtasks
            .into_iter()
            .map(|item| {
                let agent = item
                    .agent
                    .map(|agent| {
                        serde_json::from_value::<AgentKind>(Value::String(agent.clone()))
                            .map_err(|_| format!("invalid: unknown agent {agent}"))
                    })
                    .transpose()?;
                Ok(SubtaskRequest {
                    agent,
                    title: item.title,
                    prompt: item.prompt,
                    worktree: item.worktree,
                    model: item.model,
                    effort: item.effort,
                    access: item.access,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let scope = format!("create\n{}", caller.task.id);
        self.once(&scope, params.client_request_id.as_deref(), async {
            json(self.services.create_subtasks(&caller, initiation, requests).await?)
        })
        .await
    }

    #[tool(
        description = "List your subtasks: taskId, title, agent, state (working, needs-input, done, failed, idle), what they are waiting on, their last line, and worktree branch."
    )]
    async fn aiwb_subtask_list(&self, caller: Caller, _: Parameters<NoParams>) -> Reply {
        json(self.services.list_subtasks(&caller)?)
    }

    #[tool(
        description = "Read one of your subtasks' timeline, one page at a time from the newest. By default only messages, answers and plans."
    )]
    async fn aiwb_subtask_read(&self, caller: Caller, Parameters(params): Parameters<ReadParams>) -> Reply {
        json(self.services.read_subtask(
            &caller,
            &params.task_id,
            params.before,
            params.limit.unwrap_or(20),
            params.all,
        )?)
    }

    #[tool(
        description = "Send a follow-up message to one of your subtasks. Refused with `blocked` while the subtask waits for the user's approval or answer. When the turn you started ends, its result comes back to you like the first one."
    )]
    async fn aiwb_subtask_send(&self, caller: Caller, Parameters(params): Parameters<SendParams>) -> Reply {
        let steer = matches!(params.mode, Some(SendMode::Steer));
        let scope = format!("send\n{}\n{}", caller.task.id, params.task_id);
        self.once(&scope, params.client_request_id.as_deref(), async {
            json(self.services.send_subtask(&caller, &params.task_id, params.text, steer).await?)
        })
        .await
    }

    #[tool(description = "Interrupt the turn one of your subtasks is running.")]
    async fn aiwb_subtask_interrupt(&self, caller: Caller, Parameters(params): Parameters<TaskParam>) -> Reply {
        self.services.interrupt_subtask(&caller, &params.task_id).await?;
        json(serde_json::json!({ "interrupted": true }))
    }
}
