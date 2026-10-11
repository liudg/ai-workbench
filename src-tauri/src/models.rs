//! 领域模型：项目、会话、会话事件。
//! 与前端 `src/types.ts` 中的类型一一对应（serde 序列化即 IPC 协议）。

use serde::{Deserialize, Serialize};

pub type ProjectId = String;
pub type SessionId = String;

/// 已注册的 Agent CLI。新种类可以先只有探测和更新，会话仍走桩。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    CodexCli,
    ClaudeCode,
    CursorAgent,
    CopilotCli,
    KimiCode,
    QwenCode,
    /// kebab-case 会把 `OpenCode` 编成 `open-code`，线上名字是 `opencode`。
    #[serde(rename = "opencode")]
    OpenCode,
    Goose,
    /// `agy` / `antigravity` / 停更的 `gemini` 共用这一项。
    Antigravity,
    /// `kiro-cli` 与兼容入口 `q` 共用这一项。
    KiroCli,
}

impl AgentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentKind::CodexCli => "codex-cli",
            AgentKind::ClaudeCode => "claude-code",
            AgentKind::CursorAgent => "cursor-agent",
            AgentKind::CopilotCli => "copilot-cli",
            AgentKind::KimiCode => "kimi-code",
            AgentKind::QwenCode => "qwen-code",
            AgentKind::OpenCode => "opencode",
            AgentKind::Goose => "goose",
            AgentKind::Antigravity => "antigravity",
            AgentKind::KiroCli => "kiro-cli",
        }
    }

    pub fn all() -> [AgentKind; 10] {
        [
            AgentKind::CodexCli,
            AgentKind::ClaudeCode,
            AgentKind::CursorAgent,
            AgentKind::CopilotCli,
            AgentKind::KimiCode,
            AgentKind::QwenCode,
            AgentKind::OpenCode,
            AgentKind::Goose,
            AgentKind::Antigravity,
            AgentKind::KiroCli,
        ]
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            AgentKind::CodexCli => "Codex CLI",
            AgentKind::ClaudeCode => "Claude Code",
            AgentKind::CursorAgent => "Cursor Agent",
            AgentKind::CopilotCli => "GitHub Copilot CLI",
            AgentKind::KimiCode => "Kimi Code",
            AgentKind::QwenCode => "Qwen Code",
            AgentKind::OpenCode => "OpenCode",
            AgentKind::Goose => "Goose",
            AgentKind::Antigravity => "Antigravity",
            AgentKind::KiroCli => "Kiro CLI",
        }
    }
}

/// 会话运行状态。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionStatus {
    /// Agent 正在处理（流式输出中）
    Running,
    /// 等待用户输入（审批 / 回答问题）
    NeedsInput,
    /// 本轮已完成，等待下一条消息
    Completed,
    /// 异常终止
    Failed,
    /// 被用户手动停止
    Stopped,
}

/// 一个受管理的本地项目。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    /// 项目根目录的绝对路径
    pub path: String,
    pub default_agent: AgentKind,
    pub created_at: i64,
    pub updated_at: i64,
    /// 保留字段。侧边栏不再把 Agent 目录合成外部项目；已保存项目始终为 false。
    #[serde(default)]
    pub external: bool,
}

/// 项目下的一次 Agent 会话。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: SessionId,
    pub project_id: ProjectId,
    pub agent: AgentKind,
    /// Agent 自己的会话 id。工作台会话 id 是 `{agent}:{native_id}`。
    pub native_id: String,
    pub title: String,
    pub status: SessionStatus,
    pub created_at: i64,
    pub updated_at: i64,
    /// 已归档的聊天不进默认侧边栏。
    #[serde(default)]
    pub archived: bool,
}

/// 需要用户输入的提问类型。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PromptKind {
    /// 审批（允许 / 拒绝）
    Approval,
    /// 多选一
    Choice,
    /// 自由文本回答
    FreeText,
    /// Codex 原生问题卡片：一轮可多题，每题编号选项 + 自由文本，可跳过
    Questions,
    /// MCP `elicitation/request`：接受 / 拒绝 / 取消，外加表单字段。
    Elicitation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptOption {
    pub id: String,
    pub label: String,
    /// 选项的说明文字（Codex requestUserInput 的 description）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
}

/// 问题卡片中的一道题（对应 Codex requestUserInput 的单个 question，
/// 或 async 提问消息里的一条 AsyncUserInputQuestion）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptQuestion {
    /// 阻塞式提问用 Codex 的 question id；async 提问没有 id，用 q1/q2… 按序合成
    pub id: String,
    /// 题目标签（Codex header），可空
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub header: String,
    pub question: String,
    /// 回答是敏感信息（Codex isSecret），输入时掩码
    #[serde(default)]
    pub is_secret: bool,
    /// 编号展示的选项；空数组 = 纯自由文本题。elicitation 的 enum 也放这里。
    pub options: Vec<PromptOption>,
    /// elicitation 字段类型：string / number / integer / boolean。空表示普通问题。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub input_kind: String,
    /// elicitation 的 required。
    #[serde(default)]
    pub required: bool,
}

/// 前端对提问的回答。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PromptAnswer {
    /// 审批决定 / 单选项 id / 单行自由文本
    Single { value: String },
    /// 问题卡片：按题回答（题 id → 文本）；skipped 表示整卡跳过
    Questions {
        answers: std::collections::HashMap<String, String>,
        skipped: bool,
    },
    /// MCP elicitation。`action` 为 accept / decline / cancel。接受时带表单内容。
    Elicitation {
        action: String,
        #[serde(default)]
        content: std::collections::HashMap<String, serde_json::Value>,
    },
}

/// 助手文本在一轮里的位置。适配器写入，时间线只读这个字段，不比较 AgentKind。
///
/// 缺省表示协议没给阶段：时间线把该轮最后一条未标注消息当作答复。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MessagePhase {
    /// 过程中的旁白，例如「我会查看…」。后面还可能有工具或正式答复。
    Commentary,
    /// 已经成形、但后面还可能继续的回答。
    PartialAnswer,
    /// 这一轮声明的最终答复。
    FinalAnswer,
}

impl MessagePhase {
    /// 协议里的 phase 字符串。未知值保持缺省，交给时间线的兼容逻辑。
    pub fn parse(value: Option<&str>) -> Option<Self> {
        let normalized = value.map(|raw| raw.trim().to_ascii_lowercase());
        match normalized.as_deref() {
            Some("commentary") => Some(Self::Commentary),
            Some("partial_answer") | Some("partial-answer") => Some(Self::PartialAnswer),
            Some("final_answer") | Some("final-answer") => Some(Self::FinalAnswer),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanStep {
    pub step: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewFinding {
    pub title: String,
    pub location: String,
    pub body: String,
}

/// `review/start` 的目标。前端菜单和 `/review` 参数都进这里。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ReviewStart {
    Uncommitted,
    Base {
        branch: String,
    },
    Commit {
        sha: String,
        #[serde(default)]
        title: String,
    },
}

impl ReviewStart {
    /// 桌面端菜单文案。分支和提交把所选目标接在小节标题后面。
    pub fn label(&self) -> String {
        match self {
            Self::Uncommitted => "审查未提交的更改".into(),
            Self::Base { branch } => format!("对照基础分支审查: {branch}"),
            Self::Commit { sha, title } => {
                let short: String = sha.chars().take(7).collect();
                if title.trim().is_empty() {
                    format!("提交: {short}")
                } else {
                    format!("提交: {short} {}", title.trim())
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewCommit {
    pub sha: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewTargets {
    pub branches: Vec<String>,
    pub commits: Vec<ReviewCommit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 会话事件体（时间线中的一条）。`kind` 字段作为判别标签。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SessionEventBody {
    UserMessage {
        text: String,
        /// 本机路径或 `data:` / `https:` 图片。气泡用缩略图，不把文件名拼进文本。
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<String>,
    },
    AgentMessage {
        text: String,
        /// 同一条流式回复复用这个 id，会话层会覆盖已有事件而不是追加。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stream_id: Option<String>,
        /// 适配器标出的阶段。缺省不是「最终答复」，只是阶段未知。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<MessagePhase>,
    },
    /// 模型思考。有 `stream_id` 时覆盖同一条，而不是追加。
    Thinking {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stream_id: Option<String>,
    },
    ToolCall {
        name: String,
        summary: String,
        /// 命令输出、补丁正文、MCP 参数和结果。时间线默认折叠。
        #[serde(default, skip_serializing_if = "String::is_empty")]
        detail: String,
        /// 同一条命令或补丁的流式更新复用这个 id。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stream_id: Option<String>,
        /// 历史或生成结果里的图片。气泡用缩略图。
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<String>,
    },
    /// Agent 发起的提问；在被 PromptResolved 覆盖前，会话处于 needs-input
    Prompt {
        prompt_id: String,
        prompt_kind: PromptKind,
        question: String,
        options: Vec<PromptOption>,
        /// prompt_kind == Questions 时的逐题内容；其它类型为空
        #[serde(default)]
        questions: Vec<PromptQuestion>,
    },
    PromptResolved {
        prompt_id: String,
        answer: String,
    },
    StatusChanged {
        status: SessionStatus,
    },
    System {
        text: String,
    },
    /// 线程已被另一个进程占用。历史可以看，但不能发送。
    ReadOnly {
        text: String,
    },
    Error {
        message: String,
    },
    /// 作曲栏排队列表。会话层拦截，不写入时间线。
    QueueChanged {
        items: Vec<QueuedTurn>,
    },
    /// 隐藏锚点。`turn/started` 在用户消息之后发出，供 diff 绑定。
    TurnAnchor {
        turn_id: String,
    },
    /// `turn/diff/updated`。同一 `turn_id` 覆盖上一条。
    TurnDiff {
        turn_id: String,
        diff: String,
    },
    /// `turn/plan/updated`。同一 `turn_id` 覆盖上一条。
    PlanSteps {
        turn_id: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        explanation: String,
        steps: Vec<PlanStep>,
    },
    /// plan item 的正文。同一 `stream_id` 覆盖。
    PlanText {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stream_id: Option<String>,
    },
    /// `enteredReviewMode` 的 user-facing hint。
    ReviewNote {
        text: String,
    },
    /// `exitedReviewMode` 解析后的审查结果。解析失败时 findings 为空。
    ReviewFindings {
        summary: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        findings: Vec<ReviewFinding>,
        raw: String,
    },
    /// 作曲栏 Plan 开关。不进时间线正文。
    CollaborationMode {
        mode: String,
    },
}

/// 打开已被其他进程持有写锁的 Codex 线程时，给时间线和发送拒绝用的同一句说明。
pub const OCCUPIED_SESSION_NOTICE: &str =
    "这个 Codex 会话正在被另一个进程占用，已只读打开。可以查看历史，不能在这里发送。";

/// 带序列号与时间戳的完整事件（IPC 传输与前端渲染的单位）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEvent {
    pub id: String,
    pub session_id: SessionId,
    pub seq: u64,
    pub ts: i64,
    #[serde(flatten)]
    pub body: SessionEventBody,
}

/// 去掉 Windows `\\?\` 前缀，避免界面和 Codex 工作目录显示成 `\\?\F:\...`。
pub fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    path.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReasoningEffortOption {
    pub id: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentModelOption {
    pub id: String,
    pub label: String,
    pub description: String,
    pub is_default: bool,
    pub default_effort: String,
    pub efforts: Vec<ReasoningEffortOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSkillOption {
    pub name: String,
    pub mention: String,
    pub label: String,
    pub description: String,
    pub path: String,
}

/// 适配器声明的能力。前端用它决定斜杠、技能、模型和 resume，不再比较 AgentKind 字符串。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCapabilities {
    pub supports_slash: bool,
    pub supports_resume: bool,
    pub supports_questions: bool,
    pub supports_tuning: bool,
    pub supports_skills: bool,
    /// 设置页 MCP 服务器：列表、增删、登录、重启。
    #[serde(default)]
    pub supports_mcp: bool,
    /// 插件目录和 marketplace。
    #[serde(default)]
    pub supports_plugins: bool,
    /// `hooks/list`。
    #[serde(default)]
    pub supports_hooks: bool,
    /// 斜杠 `/goal`。
    #[serde(default)]
    pub supports_goals: bool,
    /// 工作树和 `environment/*`。
    #[serde(default)]
    pub supports_worktrees: bool,
    /// 图片附件作为回合输入项发送，作曲栏显示缩略图。
    #[serde(default)]
    pub supports_images: bool,
    /// 回合进行中仍可发送，消息进入适配器的排队接口。
    #[serde(default)]
    pub supports_queue: bool,
    /// 侧边栏 `thread/fork`。
    #[serde(default)]
    pub supports_fork: bool,
    /// 侧边栏归档和取消归档。
    #[serde(default)]
    pub supports_archive: bool,
    /// 侧边栏 `thread/delete`。
    #[serde(default)]
    pub supports_delete: bool,
    /// 侧边栏 `thread/name/set`。
    #[serde(default)]
    pub supports_rename: bool,
    /// `/plan` 和作曲栏 Plan 开关，走 `turn/start.collaborationMode`。
    #[serde(default)]
    pub supports_plan: bool,
    /// 回合内展开 `turn/diff/updated`。
    #[serde(default)]
    pub supports_turn_diff: bool,
    /// `/review` 打开官方目标菜单，并走 `review/start`。
    #[serde(default)]
    pub supports_review: bool,
    /// 询问批准 / 只读 / workspace-write 的网络开关。
    #[serde(default)]
    pub supports_network_access: bool,
    /// `--add-dir` 额外可写目录。
    #[serde(default)]
    pub supports_writable_roots: bool,
    /// app-server 具名权限配置档。探测前为 false。
    #[serde(default)]
    pub supports_permission_profiles: bool,
    /// `approvalsReviewer = auto_review`（替我批准）。探测前为 false。
    #[serde(default)]
    pub supports_approve_for_me: bool,
    /// 继续会话后，时间线上滚再向适配器要更早的回合，而不是一次截断。
    #[serde(default)]
    pub supports_paged_history: bool,
}

impl AgentCapabilities {
    pub fn none() -> Self {
        Self {
            supports_slash: false,
            supports_resume: false,
            supports_questions: false,
            supports_tuning: false,
            supports_skills: false,
            supports_mcp: false,
            supports_plugins: false,
            supports_hooks: false,
            supports_goals: false,
            supports_worktrees: false,
            supports_images: false,
            supports_queue: false,
            supports_fork: false,
            supports_archive: false,
            supports_delete: false,
            supports_rename: false,
            supports_plan: false,
            supports_turn_diff: false,
            supports_review: false,
            supports_network_access: false,
            supports_writable_roots: false,
            supports_permission_profiles: false,
            supports_approve_for_me: false,
            supports_paged_history: false,
        }
    }

    pub fn codex() -> Self {
        Self {
            supports_slash: true,
            supports_resume: true,
            supports_questions: true,
            supports_tuning: true,
            supports_skills: true,
            supports_mcp: true,
            supports_plugins: true,
            supports_hooks: true,
            supports_goals: true,
            supports_worktrees: true,
            supports_images: true,
            supports_queue: true,
            supports_fork: true,
            supports_archive: true,
            supports_delete: true,
            supports_rename: true,
            supports_plan: true,
            supports_turn_diff: true,
            supports_review: true,
            supports_network_access: true,
            supports_writable_roots: true,
            supports_permission_profiles: false,
            supports_approve_for_me: false,
            supports_paged_history: true,
        }
    }
}

/// 作曲栏权限菜单要不要画出替我批准和自定义配置档。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PermissionProfileOption {
    pub id: String,
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PermissionMenu {
    pub network_access: bool,
    pub writable_roots: bool,
    pub permission_profiles: bool,
    pub approve_for_me: bool,
    pub profiles: Vec<PermissionProfileOption>,
}

impl PermissionMenu {
    pub fn unsupported() -> Self {
        Self {
            network_access: false,
            writable_roots: false,
            permission_profiles: false,
            approve_for_me: false,
            profiles: Vec::new(),
        }
    }
}

/// 上滚加载更早回合之后的整段事件日志。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OlderHistory {
    pub events: Vec<SessionEvent>,
    pub added: usize,
    pub exhausted: bool,
}

/// 一条排在当前回合后面的用户消息。作曲栏展示它，不进时间线。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QueuedTurn {
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashCommand {
    pub name: String,
    pub hint: String,
    #[serde(default)]
    pub takes_args: bool,
}

/// 不依赖已打开会话的静态能力说明。斜杠命令表在这里，模型/技能在会话 catalog 里。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentProfile {
    pub kind: AgentKind,
    pub capabilities: AgentCapabilities,
    pub commands: Vec<SlashCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCatalog {
    pub models: Vec<AgentModelOption>,
    pub skills: Vec<AgentSkillOption>,
    pub commands: Vec<SlashCommand>,
    pub capabilities: AgentCapabilities,
}

impl AgentCatalog {
    pub fn empty() -> Self {
        Self {
            models: Vec::new(),
            skills: Vec::new(),
            commands: Vec::new(),
            capabilities: AgentCapabilities::none(),
        }
    }
}

/// 官方升级走哪条已声明的渠道。前端只展示，不拼命令。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateVia {
    /// `npm install -g <package>@latest`
    Npm,
    /// 适配器声明的 CLI 自更新，例如 `claude update`。
    Cli,
}

/// 本机一次探测的结果。设置页列出全部已注册 CLI；新建会话只取 `installed`。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentInstallation {
    pub kind: AgentKind,
    pub display_name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub update_via: Option<UpdateVia>,
    pub detail: Option<String>,
}

impl AgentInstallation {
    pub fn absent(kind: AgentKind, display_name: &str) -> Self {
        Self {
            kind,
            display_name: display_name.to_string(),
            installed: false,
            version: None,
            latest_version: None,
            update_available: false,
            update_via: None,
            detail: None,
        }
    }
}

/// MCP 传输。桌面端添加服务器时二选一：STDIO 或 Streamable HTTP。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum McpTransport {
    Stdio,
    Http,
}

/// 一条 MCP 服务器。配置来自 `config/read`，运行状态来自 `mcpServerStatus/list`。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpServerRecord {
    pub name: String,
    pub transport: McpTransport,
    pub command: String,
    pub args: Vec<String>,
    pub url: String,
    pub enabled: bool,
    /// 协议原值：unknown / unsupported / notLoggedIn / bearerToken / oAuth。空表示没有状态。
    pub auth_status: String,
    /// 协议原值：notStarted / starting / connected / authenticationRequired / failed / cancelled / disabled。
    pub runtime_status: String,
    pub tool_names: Vec<String>,
    pub tools_error: String,
    /// 非空表示服务器由插件提供，不能在 MCP 列表里直接删除。
    pub plugin_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpLogin {
    pub authorization_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReloadReport {
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginRecord {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub developer: String,
    pub marketplace_name: String,
    pub marketplace_path: String,
    pub installed: bool,
    pub enabled: bool,
    pub availability: String,
    pub install_policy: String,
    pub source: String,
    pub needs_install_confirm: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MarketplaceRecord {
    pub name: String,
    pub display_name: String,
    pub path: String,
    pub plugins: Vec<PluginRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginCatalog {
    pub marketplaces: Vec<MarketplaceRecord>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HookRecord {
    pub cwd: String,
    pub event_name: String,
    pub handler: String,
    pub source: String,
    pub trust_status: String,
    pub enabled: bool,
    pub status_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorktreeInfo {
    pub path: String,
    pub head: String,
    pub branch: String,
    pub detached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorktreeSettings {
    pub root: String,
    /// 官方默认保留最近 15 个 Codex 管理的工作树。
    pub keep: u32,
    pub auto_prune: bool,
    pub worktrees: Vec<WorktreeInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentRecord {
    pub id: String,
    /// ready / pending / disconnected / unknown
    pub status: String,
    pub error: String,
    pub cwd: String,
    pub shell: String,
}

pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_catalog_without_image_flags_stays_off() {
        let parsed: AgentCapabilities = serde_json::from_str(
            r#"{
                "supports_slash": true,
                "supports_resume": true,
                "supports_questions": true,
                "supports_tuning": true,
                "supports_skills": true
            }"#,
        )
        .unwrap();
        assert!(parsed.supports_slash);
        assert!(!parsed.supports_images);
        assert!(!parsed.supports_queue);
        assert!(!parsed.supports_mcp);
        assert!(!parsed.supports_plan);
        assert!(!parsed.supports_turn_diff);
        assert!(!parsed.supports_review);
        assert!(!parsed.supports_network_access);
        assert!(!parsed.supports_writable_roots);
        assert!(!parsed.supports_permission_profiles);
        assert!(!parsed.supports_approve_for_me);
        assert!(!parsed.supports_paged_history);
    }
}
