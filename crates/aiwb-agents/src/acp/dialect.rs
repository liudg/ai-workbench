//! 一种 ACP Agent 和共用运行时之间的差别。协议的公共部分在 [`super::runtime`]。

use std::borrow::Cow;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use super::permission;
use super::runtime::Shared;
use super::updates;
use crate::AgentError;
use aiwb_core::models::{
    AgentCatalog, PermissionMenu, PlanStep, PromptAnswer, SessionEventBody, SessionStatus,
};

/// 工具调用的主题：路径要换成相对项目的写法。
pub enum ToolSubject {
    Path(String),
    Text(String),
}

/// 一条 `content[].type = diff` 里的路径和前后全文。
pub struct DiffTexts {
    pub path: String,
    pub old: Option<String>,
    pub new: Option<String>,
}

/// 一条工具更新在时间线上的样子。
pub enum ToolView {
    /// 普通工具卡片，改动记进本回合。
    Card,
    /// 工具卡片，但写的是 Agent 自己的产物，不算项目改动。
    Artifact,
    /// 不进时间线，比如已经画成提问卡的工具。
    Hidden,
    /// 计划正文。
    Plan { text: String },
    /// 待办清单。
    Steps(Vec<PlanStep>),
}

/// `session/update` 的方言。纯函数，实时回合和回放共用。
pub trait UpdateRules: Send + Sync {
    /// 后端报错被当成回答文字发出来时的开头。
    fn error_tail(&self) -> &'static str;

    fn error_message(&self, detail: &str) -> String;

    /// 回答里要显示的部分。`text` 是这一段到目前为止的全文。
    fn message_view<'a>(&self, text: &'a str) -> Cow<'a, str> {
        Cow::Borrowed(text)
    }

    fn path(&self, raw: &str) -> String {
        raw.to_string()
    }

    fn diff_texts(&self, item: &Value) -> Option<DiffTexts>;

    fn tool_view(&self, _update: &Value) -> ToolView {
        ToolView::Card
    }

    fn tool_name(&self, kind: &str, title: &str, _native: &str) -> String {
        updates::tool_name(kind, title)
    }

    fn tool_subject(&self, kind: &str, input: &Value) -> Option<ToolSubject>;

    /// 工具结果文字里提到的生成图。
    fn tool_images(&self, _detail: &str) -> Vec<String> {
        Vec::new()
    }

    /// 工具结果 `content[]` 里的一段文字。
    fn content_text(&self, text: &str) -> String {
        text.to_string()
    }

    /// 宿主自己发的、回放时不算用户消息的提示。
    fn hides_user_message(&self, _text: &str) -> bool {
        false
    }

    /// 工具结果里的文字。
    fn tool_output(&self, output: &Value) -> String {
        updates::output_text(output)
    }

    fn exit_code(&self, output: &Value) -> Option<i64> {
        output.get("exitCode").and_then(Value::as_i64)
    }
}

/// 界面对一条待答问题的回答怎么回给 Agent。
pub trait PendingAnswer: Send + Sync {
    /// 回包正文和时间线上显示的答案。
    fn respond(&self, answer: &PromptAnswer) -> Result<(Value, String), AgentError>;

    /// 回包已发出之后。回答要改变会话状态时覆盖。这时还持着状态锁。
    fn settled(&self, _shared: &Arc<Shared>, _result: &Value) {}

    /// 回合被打断时的回包。
    fn cancelled(&self) -> Value {
        permission::cancelled()
    }
}

/// 一种 Agent 的会话行为。每条会话一个实例，可以持有这条会话自己的状态。
#[async_trait]
pub trait Dialect: Send + Sync + 'static {
    /// 报错里用的名字。
    fn label(&self) -> &'static str;

    fn rules(&self) -> &'static dyn UpdateRules;

    fn not_logged_in(&self) -> String;

    /// 把工作台档位收成这个 Agent 真有的档。
    fn access_level(&self, mode: &str) -> &'static str;

    fn permission_menu(&self, active: &str) -> PermissionMenu;

    /// 计划开关和权限档合起来对应的 `session/set_mode`。
    fn mode_id(&self, plan: bool, access: &str) -> &'static str;

    /// 回合进行中再发 `session/prompt` 就是引导，不用先取消。
    fn steers_in_place(&self) -> bool {
        false
    }

    /// 取消的回合还在 Agent 的上下文里，下一条不用补。
    fn keeps_cancelled_turns(&self) -> bool {
        false
    }

    /// 这个 Agent 的请求里，哪些要等用户回答。
    fn asks_user(&self, method: &str) -> bool {
        method == "session/request_permission"
    }

    /// 回合已经停了，还来问用户时的回包。
    fn cancelled_reply(&self, _method: &str) -> Value {
        permission::cancelled()
    }

    /// 工作台自己的 MCP 工具，免审批。
    fn workbench_tool(&self, params: &Value) -> bool;

    /// 标准之外的 Agent 请求。认领了返回 true，否则按 `METHOD_NOT_FOUND` 回。
    fn on_request(&self, _shared: &Shared, _id: &Value, _method: &str, _params: &Value) -> bool {
        false
    }

    /// 进时间线之前改写这条更新。不需要改时返回 None。
    fn rewrite_update(&self, _update: &Value) -> Option<Value> {
        None
    }

    /// 子 Agent 之类不进主时间线的更新。认领了返回事件。
    fn on_update(&self, _session: &str, _update: &Value) -> Option<Vec<SessionEventBody>> {
        None
    }

    /// `session/new` / `session/load` / `session/resume` 的回包，写模型目录。
    fn adopt_session(&self, _catalog: &mut AgentCatalog, _payload: &Value) {}

    /// 进程没了或回合被打断时收尾。
    fn stop_extras(&self) -> Vec<SessionEventBody> {
        Vec::new()
    }

    /// `session/prompt` 的回包，写用量。
    fn turn_reply(&self, _shared: &Shared, _reply: &Value) -> Vec<SessionEventBody> {
        Vec::new()
    }

    /// `session/prompt` 已回包但工作还没完（比如在等子 Agent）时，让回合继续算运行中。
    async fn settle_turn(&self, _shared: &Arc<Shared>) {}

    /// 用户要发给 Agent 的一条正文（还没发出）。
    fn before_submit(&self, _text: &str) {}

    /// 回合真正结束、状态已经发出之后。
    fn turn_ended(&self, _shared: &Arc<Shared>, _status: SessionStatus) {}

    /// 进程已退出。
    fn after_exit(&self, _session_id: &str) {}

    /// 额外目录可以中途换：返回重新打开这条会话要带的参数。
    fn reopen_params(&self, _shared: &Shared, _roots: &[String]) -> Option<Value> {
        None
    }

    fn set_goal(&self, _shared: &Arc<Shared>, _objective: &str) -> Result<(), AgentError> {
        Err(AgentError::Runtime("这个 Agent 没有目标".into()))
    }

    fn clear_goal(&self, _shared: &Arc<Shared>) -> Result<(), AgentError> {
        Err(AgentError::Runtime("这个 Agent 没有目标".into()))
    }

    fn publish_goal(&self, _shared: &Shared) {}

    fn set_goal_status(&self, _shared: &Arc<Shared>, _status: &str) -> Result<(), AgentError> {
        Err(AgentError::Runtime("这个 Agent 不能暂停目标".into()))
    }
}
