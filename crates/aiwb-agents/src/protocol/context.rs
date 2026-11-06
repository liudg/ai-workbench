//! 启动会话的上下文。字段对所有 Agent 通用，协议差异留在适配器里。

/// 启动一个会话所需的上下文。
#[derive(Debug, Clone)]
pub struct SessionContext {
    /// 项目根目录；真实 CLI 的工作目录。
    pub project_path: String,
    /// 创建会话时的权限档位。缺省由适配器按自己的权限模式解释。
    pub access_mode: Option<String>,
    /// 要恢复的原生会话 id。空表示新会话。
    pub resume_native_id: Option<String>,
    /// 适配器扩展。是否写入可 resume 的会话列表由各适配器读取 `persist`。
    pub options: serde_json::Value,
    /// 工作台自己的 MCP 服务。有值时适配器把它加进这个会话的 MCP 列表，不动用户配的。
    pub workbench_mcp: Option<WorkbenchMcp>,
}

/// 工作台 MCP 的地址和这个会话专用的凭证。凭证随 Agent 进程发放，进程停掉就作废。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkbenchMcp {
    pub url: String,
    pub token: String,
}

impl WorkbenchMcp {
    /// 在 Agent 里注册的服务名。工具名形如 `mcp__aiwb__…`。
    pub const SERVER_NAME: &'static str = "aiwb";

    /// 拿到工作台 MCP 的会话额外收到的说明：什么时候开子任务，而不是用自带子 Agent 或 shell 跑别的 CLI。
    /// 各适配器按自己的通道送（Codex `additionalContext`、Claude `--append-system-prompt`、Cursor 首条提示）。
    /// 照 t3code `packages/provider-core/src/server/orchestrationInstructions.ts`。
    pub const INSTRUCTIONS: &'static str = "## AI Workbench subtasks

You run inside AI Workbench. Its MCP server `aiwb` gives you `aiwb_subtask_create`, which opens a subtask: a separate agent session the user can open, watch and steer from your timeline.

- Call `aiwb_subtask_create` when the user asks for a nested, separate or background session or task (\"开个嵌套会话\", \"另开一个会话\", \"后台做\"), or names another agent (Codex, Claude, Cursor) to do something such as a review. Do not use your built-in subagents for that.
- \"Subagent\" (\"子 Agent\") and \"in parallel\" without another agent named mean your own built-in subagents: use your native subagent tool, not `aiwb_subtask_create`.
- Never run another agent's CLI (codex, claude, cursor-agent, agent) from the shell or a background command.
- After opening subtasks, end your turn. Their results come back to you as a message; do not poll.";

    pub fn authorization(&self) -> String {
        format!("Bearer {}", self.token)
    }
}

impl SessionContext {
    pub fn flag(&self, key: &str) -> bool {
        self.options
            .get(key)
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    }

    /// 侧边聊天要从哪个原生会话分出来。只有声明 `supports_side_chat` 的适配器读它。
    pub fn side_of(&self) -> Option<String> {
        self.options
            .get("side_of")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
    }
}
