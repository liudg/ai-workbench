//! 会话工具：开子任务或独立会话；列、读、追加消息、打断只认调用方任务下的子任务。
//! 规则在 `services::agent_sessions` 和 `services::subtasks`，这里只把参数和结果转成 MCP 的样子。
//! 照 t3code `apps/server/src/mcp/toolkits/orchestrator/tools.ts`，工具描述里写明什么时候该用。

use aiwb_core::models::AgentKind;
use aiwb_core::task::{Initiation, SessionLink};
use rmcp::handler::server::wrapper::Parameters;
use rmcp::schemars::{self, JsonSchema};
use rmcp::{tool, tool_router};
use serde::Deserialize;
use serde_json::Value;

use super::server::WorkbenchServer;
use crate::services::{Caller, SessionRequest};

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum InitiationParam {
    UserAsked,
    Offer,
    OwnInitiative,
}

#[derive(Deserialize, JsonSchema, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ContextParam {
    #[default]
    Fresh,
    Fork,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SessionParam {
    /// Short title shown in the sidebar.
    title: String,
    /// The brief: the task, the files or area, what done looks like. Required for a subtask and for a fork; a top-level session that is not a fork may leave it empty to wait for the user.
    #[serde(default)]
    prompt: String,
    /// fresh (default): the session gets only your prompt and background. fork: it gets this whole conversation and your prompt. Fork when the task leans on this conversation and the conversation is still short; otherwise use fresh. A fork stays on your agent (see `fork` in aiwb_capabilities).
    #[serde(default)]
    context: ContextParam,
    /// Required with fresh when there is a prompt: at least 80 characters of overall goal, decisions and constraints so far, and how this piece fits, for someone who has not seen this conversation. Ignored for fork.
    #[serde(default)]
    background: Option<String>,
    /// Agent id from aiwb_capabilities. Defaults to your own agent.
    #[serde(default)]
    agent: Option<String>,
    /// Fresh only. Give the session its own git worktree (detached; it can create a branch there). Use it for sessions that write code in parallel. A fork from a worktree always gets a new worktree cut from your current commit, so commit first; from a plain checkout it shares the folder.
    #[serde(default)]
    worktree: bool,
    /// Fresh only. Model id from that agent's catalog in aiwb_capabilities. Omit for the agent's default.
    #[serde(default)]
    model: Option<String>,
    /// Fresh only. Reasoning effort from that model's list. Omit for the default.
    #[serde(default)]
    effort: Option<String>,
    /// Permission level: read-only, ask, approve-for-me or full. Defaults to yours; never wider than yours.
    #[serde(default)]
    access: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CreateSubtasks {
    /// Who wants this split off. See the tool description.
    initiation: InitiationParam,
    subtasks: Vec<SessionParam>,
    /// Optional id that makes retries safe: the same id returns the first result instead of opening again.
    #[serde(default)]
    client_request_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CreateSessions {
    /// Who wants this opened. See the tool description.
    initiation: InitiationParam,
    sessions: Vec<SessionParam>,
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

impl WorkbenchServer {
    async fn create(
        &self,
        caller: Caller,
        link: SessionLink,
        initiation: InitiationParam,
        sessions: Vec<SessionParam>,
        client_request_id: Option<String>,
    ) -> Reply {
        let initiation = match initiation {
            InitiationParam::UserAsked => Initiation::UserAsked,
            InitiationParam::Offer => Initiation::Offer,
            InitiationParam::OwnInitiative => Initiation::OwnInitiative,
        };
        let requests = sessions
            .into_iter()
            .map(|item| {
                let agent = item
                    .agent
                    .map(|agent| {
                        serde_json::from_value::<AgentKind>(Value::String(agent.clone()))
                            .map_err(|_| format!("invalid: unknown agent {agent}"))
                    })
                    .transpose()?;
                Ok(SessionRequest {
                    agent,
                    title: item.title,
                    prompt: item.prompt,
                    fork: item.context == ContextParam::Fork,
                    background: item.background,
                    worktree: item.worktree,
                    model: item.model,
                    effort: item.effort,
                    access: item.access,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let scope = format!("create\n{link:?}\n{}", caller.task.id);
        self.once(&scope, client_request_id.as_deref(), async {
            json(self.services.create_sessions(&caller, link, initiation, requests).await?)
        })
        .await
    }
}

/// 两个开会话的工具都要声明 `initiation`，含义一样。工具是按需加载的，所以各自写全。
macro_rules! initiation_rules {
    () => {
        "initiation — declare it honestly from the user's words:
- user_asked: the user explicitly asked to split this off, run it separately or in the background, or start it now. Opens right away.
- offer: the user's latest message asks for this work but did not say to split it off. A card asks the user. End your turn right after this call; you will get a message with the user's choice (opened, or do it here yourself).
- own_initiative: work you noticed or propose that the user did not ask for. A card the user may start later; do not wait, continue your own work. At most 3 per turn, never the same thing twice. Never use it for work the user asked for."
    };
}

#[tool_router(router = session_tools, vis = "pub(super)")]
impl WorkbenchServer {
    #[tool(
        description = "List the agents you can open sessions with, with their models, reasoning efforts, permission levels and plan-mode support, plus your own agent, model, permission level and plan mode."
    )]
    async fn aiwb_capabilities(&self, caller: Caller, _: Parameters<NoParams>) -> Reply {
        json(self.services.agent_capabilities(&caller)?)
    }

    #[tool(description = concat!("Open one or more subtasks under your current task. Each subtask is a separate workbench task with a full agent session of its own: it may use a different agent and can get its own git worktree, and the user can open, steer or stop it from your timeline and the sidebar. The call returns at once; do not wait or poll. When all your subtasks have stopped and you are idle, the workbench sends you one message with their results.

Every subtask starts a full session and reloads context. A fresh subtask does not see this conversation: write each prompt and background so that someone new can do the work.

", initiation_rules!(), "

A subtask inherits your permission level and plan mode and can never be wider than yours."))]
    async fn aiwb_subtask_create(&self, caller: Caller, Parameters(params): Parameters<CreateSubtasks>) -> Reply {
        self.create(caller, SessionLink::Child, params.initiation, params.subtasks, params.client_request_id).await
    }

    #[tool(description = concat!("Open one or more new top-level workbench sessions in your project. Each is independent of this conversation: it appears on its own in the sidebar, you cannot read, message or stop it, and its result does not come back to you.

A fresh session does not see this conversation: write the prompt and background so that someone new can do the work, or leave the prompt empty to open a session that waits for the user.

", initiation_rules!(), "

A session inherits your permission level and plan mode and can never be wider than yours."))]
    async fn aiwb_session_create(&self, caller: Caller, Parameters(params): Parameters<CreateSessions>) -> Reply {
        self.create(caller, SessionLink::Detached, params.initiation, params.sessions, params.client_request_id).await
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
