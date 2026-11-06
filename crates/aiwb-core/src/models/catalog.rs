use serde::{Deserialize, Serialize};

use super::agent::AgentKind;
use super::event::SessionEvent;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReasoningEffortOption {
    pub id: String,
    pub description: String,
    /// CLI 给的短名（`displayName` / `label`）。界面按档位 id 显示中文短标签，不渲染 description。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// `model/list` 的一个 service tier。`fast` 由适配器按 CLI 的快速档标上，界面不认 id。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelServiceTier {
    pub id: String,
    pub name: String,
    pub description: String,
    /// 作曲栏闪电开关要写入的档。没有标记就不显示开关。
    #[serde(default, skip_serializing_if = "is_false")]
    pub fast: bool,
}

fn default_show_in_picker() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentModelOption {
    pub id: String,
    pub label: String,
    pub description: String,
    pub is_default: bool,
    pub default_effort: String,
    pub efforts: Vec<ReasoningEffortOption>,
    /// 缺省为 true，旧缓存没有这个字段时模型仍然出现在选择器里。
    #[serde(default = "default_show_in_picker")]
    pub show_in_picker: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub service_tiers: Vec<ModelServiceTier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_service_tier: Option<String>,
    /// CLI `resolvedModel`（自定义映射后的真实模型名）。选模时用来对齐 applied.model。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub resolved_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSkillOption {
    pub name: String,
    pub mention: String,
    pub label: String,
    pub description: String,
    pub path: String,
}

/// 变更从哪来：回合 diff、逐文件补丁、git 范围。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChangeCapabilities {
    /// 回合统一 diff（`turn-diff`）。
    #[serde(default)]
    pub turn_diff: bool,
    /// 逐文件补丁（`file-change` / `turn-changes`）。
    #[serde(default)]
    pub per_file_patch: bool,
    /// 未提交 / 未暂存 / 已暂存。默认实现走 git。
    #[serde(default)]
    pub git_scopes: bool,
}

impl ChangeCapabilities {
    pub fn none() -> Self {
        Self {
            turn_diff: false,
            per_file_patch: false,
            git_scopes: false,
        }
    }

    pub fn codex() -> Self {
        Self {
            turn_diff: true,
            per_file_patch: true,
            git_scopes: true,
        }
    }
}

/// 适配器声明的能力。前端用它决定斜杠、技能、模型和 resume，不再比较 AgentKind 字符串。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCapabilities {
    pub supports_slash: bool,
    pub supports_resume: bool,
    pub supports_questions: bool,
    pub supports_tuning: bool,
    pub supports_skills: bool,
    /// 斜杠 `/goal`。
    #[serde(default)]
    pub supports_goals: bool,
    /// 图片附件作为回合输入项发送，作曲栏显示缩略图。
    #[serde(default)]
    pub supports_images: bool,
    /// 回合进行中仍可发送，消息进入适配器的排队接口。
    #[serde(default)]
    pub supports_queue: bool,
    /// 回合进行中可以中断当前回合。停止按钮只看这项，不看排队。
    #[serde(default)]
    pub supports_cancel: bool,
    /// 原生分叉（Codex `thread/fork`）。分叉任务时同一个 Agent 用它，否则另起一段带上前文。
    #[serde(default)]
    pub supports_fork: bool,
    /// `/plan` 和作曲栏计划芯片，走 `turn/start.collaborationMode`。
    #[serde(default)]
    pub supports_plan: bool,
    /// 回合 diff、逐文件补丁、git 范围。
    #[serde(default)]
    pub changes: ChangeCapabilities,
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
    /// 账号订阅额度窗口（已用或剩余百分比，以及重置时间）。没有原生数据的适配器保持关闭。
    #[serde(default)]
    pub supports_subscription_usage: bool,
    /// 会话中途换成别的 Agent，或者从别的 Agent 换过来：前文作为第一条消息的文字交过去。
    /// 照 t3code 适配器的 `supportsProviderSwitchingViaHandoff`。
    #[serde(default)]
    pub supports_context_handoff: bool,
    /// 换工作目录后 resume 原来的会话（任务交给项目目录、交回工作树时用）。
    /// Claude 2.1.312、codex-cli 0.165.0 实测过；Cursor 按 ACP 协议打开，还没用真实 CLI 实测。
    #[serde(default)]
    pub supports_workdir_move: bool,
    /// 侧边聊天：从当前对话临时分出一条，不进历史，关掉就丢。
    #[serde(default)]
    pub supports_side_chat: bool,
    /// 单独停掉 Agent 自带的一个子 Agent，主回合接着跑。
    #[serde(default)]
    pub supports_subagent_stop: bool,
}

impl AgentCapabilities {
    pub fn none() -> Self {
        Self {
            supports_slash: false,
            supports_resume: false,
            supports_questions: false,
            supports_tuning: false,
            supports_skills: false,
            supports_goals: false,
            supports_images: false,
            supports_queue: false,
            supports_cancel: false,
            supports_fork: false,
            supports_plan: false,
            changes: ChangeCapabilities::none(),
            supports_review: false,
            supports_network_access: false,
            supports_writable_roots: false,
            supports_permission_profiles: false,
            supports_approve_for_me: false,
            supports_paged_history: false,
            supports_subscription_usage: false,
            supports_context_handoff: false,
            supports_workdir_move: false,
            supports_side_chat: false,
            supports_subagent_stop: false,
        }
    }

    pub fn codex() -> Self {
        Self {
            supports_slash: true,
            supports_resume: true,
            supports_questions: true,
            supports_tuning: true,
            supports_skills: true,
            supports_goals: true,
            supports_images: true,
            supports_queue: true,
            // `turn/interrupt` 带当前 turn id（`agents/codex/rpc.rs`）。
            supports_cancel: true,
            supports_fork: true,
            supports_plan: true,
            changes: ChangeCapabilities::codex(),
            supports_review: true,
            supports_network_access: true,
            supports_writable_roots: true,
            supports_permission_profiles: false,
            supports_approve_for_me: false,
            supports_paged_history: true,
            // 2026-10-16 本机 Codex CLI 0.162.1：`account/rateLimits/read` 带回 `usedPercent` 与 `resetsAt`。
            supports_subscription_usage: true,
            // 交接只是第一条 `turn/start` 的文字输入。
            supports_context_handoff: true,
            // 2026-11-04 codex-cli 0.165.0：换目录 resume 后记忆还在，命令在新目录里跑；`thread/resume` 带 `cwd`。
            supports_workdir_move: true,
            // 2026-11-02 本机 Codex CLI 0.165.0：父线程回合进行中，另一个 app-server 进程
            // `thread/fork { ephemeral: true }` + `thread/inject_items` 后能接着问，`thread/list` 里没有它。
            supports_side_chat: true,
            // 子 Agent 是同一连接上的子线程：`turn/interrupt` 带子线程 id 和它的回合 id。
            supports_subagent_stop: true,
        }
    }

    /// Claude Code 会话能力。关闭项的证据来自 2026-10-15 本机 Claude Code 2.1.300。
    /// 回合 diff 不是 CLI 事件，由 Edit/Write 的工具输入或结果拼出来。
    pub fn claude() -> Self {
        Self {
            supports_slash: true,
            supports_resume: true,
            supports_questions: true,
            supports_tuning: true,
            supports_skills: true,
            supports_goals: true,
            supports_images: true,
            supports_queue: true,
            // stdin `{"subtype":"interrupt"}`。CLI 把这次停止报成 aborted_streaming / aborted_user。
            supports_cancel: true,
            supports_fork: true,
            supports_plan: true,
            changes: ChangeCapabilities {
                turn_diff: true,
                per_file_patch: true,
                git_scopes: true,
            },
            // 没有 `review/start`。`claude ultrareview --help` 是云端多 Agent 审查当前分支，
            // 不是工作台的分支/提交目标菜单。二进制里的 `/review` 只出现在示例技能名。
            supports_review: false,
            // `claude --print hi --network --output-format json` 退出码 1：
            // `error: unknown option '--network'`。`--permission-mode` 只有
            // acceptEdits、auto、bypassPermissions、manual、dontAsk、plan。
            supports_network_access: false,
            supports_writable_roots: true,
            // `--permission-mode` 没有具名配置档。`get_sandbox_dialog` 不是配置档列表。
            supports_permission_profiles: false,
            // 没有 `auto_review`。`approve-for-me` 和 `read-only` 不能映射到 permission mode。
            supports_approve_for_me: false,
            supports_paged_history: true,
            // 2026-10-16 本机 Claude Code 2.1.300：`get_usage` 回包带 `rate_limits`
            // （utilization 0–100、resets_at）。当前账号是第三方令牌，实读为 null，界面不画。
            supports_subscription_usage: true,
            // 交接只是第一条 stdin 用户消息的文字。
            supports_context_handoff: true,
            // 2026-11-04 本机 Claude Code 2.1.312：在别的目录 `--resume` 记忆还在，工作目录是新目录。
            supports_workdir_move: true,
            // 2026-11-02 本机 Claude Code 2.1.312：父会话回合进行中，
            // `--resume=<父> --fork-session --session-id=<新> --no-session-persistence` 能连着问多轮，转录不落盘。
            supports_side_chat: true,
            // stdin 控制请求 `{"subtype":"stop_task","task_id":…}`（Claude Code 2.1.312 的 control 协议）。
            supports_subagent_stop: true,
        }
    }

    /// Cursor Agent 会话（`agent acp`）。证据来自 2026-10-29 本机 Cursor Agent 2026.10.22-27dcf5f。
    pub fn cursor() -> Self {
        Self {
            // `available_commands_update` 给出斜杠命令和技能，正文里写 `/名字` 发出去。
            supports_slash: true,
            // `initialize` 回包 `loadSession: true`，`session/load` 回放整段历史。
            supports_resume: true,
            // 扩展方法 `cursor/ask_question`：选项题，可多选，没有自由文本。2026-10-29 实测服务端给 ACP 会话的
            // 工具表里没有 AskQuestion，模型暂时不会发起；收到时照常画问题卡。
            supports_questions: true,
            // `cursor/list_available_models` 每个模型带 `thought_level` 参数，`session/set_config_option` 切换。
            supports_tuning: true,
            // 技能也在 `available_commands_update` 里，走斜杠菜单，没有单独的技能列表。
            supports_skills: false,
            supports_goals: false,
            // `promptCapabilities.image = true`。
            supports_images: true,
            // 本地排队；引导用 ACP cancel 收尾后在同一 session 继续 prompt。
            supports_queue: true,
            // `session/cancel`，这一轮以 `stopReason = cancelled` 收尾。
            supports_cancel: true,
            // 没有分叉方法。
            supports_fork: false,
            // `session/set_mode` 的 `plan`，计划由 `cursor/create_plan` 交回。
            supports_plan: true,
            // 编辑工具结果带 `content[].type = diff`（原文和新文）。
            changes: ChangeCapabilities {
                turn_diff: true,
                per_file_patch: true,
                git_scopes: true,
            },
            supports_review: false,
            supports_network_access: false,
            // `--add-dir` 只是启动参数，ACP 会话里不能追加。
            supports_writable_roots: false,
            supports_permission_profiles: false,
            // `--auto-review` 在 `agent acp` 里不生效（`src/acp` 不读这个选项）。
            supports_approve_for_me: false,
            supports_paged_history: false,
            // `agent about` / `status` 只有账号，没有额度窗口。
            supports_subscription_usage: false,
            // 交接只是第一条 `session/prompt` 的文字。
            supports_context_handoff: true,
            // ACP 的 `session/load` 本来就带 `cwd`，适配器换目录接着会话时传新目录。
            // 本机没有 Cursor CLI，换目录这条还没用真实 CLI 实测过（docs/worktree-lifecycle.md）。
            supports_workdir_move: true,
            // 没有分叉方法，分不出带着前文的临时会话。
            supports_side_chat: false,
            // `session/cancel` 只认主会话（`3635.index.js` 的 `cancel` 查 `this.sessions`），
            // 子 Agent 只能跟着主回合一起停。
            supports_subagent_stop: false,
        }
    }
}

/// 权限菜单里的一项：内置档位或具名配置档。文案由适配器给出。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PermissionProfileOption {
    pub id: String,
    pub label: String,
    pub description: String,
    /// 有值时这一项不可选，值是原因。
    #[serde(default)]
    pub disabled_reason: Option<String>,
    /// 选中时按钮用警示色。适配器标，界面不按 id 猜。
    #[serde(default, skip_serializing_if = "is_false")]
    pub caution: bool,
    /// 选中这一档时可以显示网络开关和额外目录。
    #[serde(default, skip_serializing_if = "is_false")]
    pub allows_extras: bool,
}

/// 作曲栏权限菜单。`presets` 的 id 是工作台档位（ask / approve-for-me / full / read-only）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PermissionMenu {
    pub network_access: bool,
    pub writable_roots: bool,
    pub permission_profiles: bool,
    pub approve_for_me: bool,
    #[serde(default)]
    pub title: String,
    /// 菜单副标题：读取失败的原因，或服务端没有返回任何配置档。
    #[serde(default)]
    pub notice: Option<String>,
    #[serde(default)]
    pub presets: Vec<PermissionProfileOption>,
    pub profiles: Vec<PermissionProfileOption>,
    /// 这一会话当前档位 id。界面不另猜。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<String>,
}

impl PermissionMenu {
    pub fn unsupported() -> Self {
        Self {
            network_access: false,
            writable_roots: false,
            permission_profiles: false,
            approve_for_me: false,
            title: String::new(),
            notice: None,
            presets: Vec::new(),
            profiles: Vec::new(),
            active: None,
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
    /// 新建会话的权限档。空表示适配器自己决定，界面不要拿另一个 Agent 的上次选择。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_access: Option<String>,
    /// 适配器显示名。侧栏只读这一份，不另做名字表，也不借用别的 Agent。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// 侧栏图标资源。没有文件时为 None，界面用中性图标。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCatalog {
    pub models: Vec<AgentModelOption>,
    pub skills: Vec<AgentSkillOption>,
    pub commands: Vec<SlashCommand>,
    pub capabilities: AgentCapabilities,
    /// `skills/list` 失败且没有可保留的技能时的原因。成功拉到空列表时为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills_error: Option<String>,
    /// CLI `config/read` 的 `model`。空表示配置里没写，不是目录里的 isDefault。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configured_model: Option<String>,
    /// CLI `config/read` 的 `model_reasoning_effort`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configured_effort: Option<String>,
    /// CLI `config/read` 的 `service_tier`。`default` 在解析时丢掉。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configured_service_tier: Option<String>,
    /// 已打开线程回包里的模型。新会话还没有。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_effort: Option<String>,
    /// `Some(false)` 表示 `config/read` 失败。缺省是旧缓存，不能当成失败。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_config_read: Option<bool>,
    /// 这份目录属于哪个 Agent。对不上当前会话时不能拿来显示，也不能写入另一个 Agent 的缓存。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentKind>,
}

impl AgentCatalog {
    pub fn empty() -> Self {
        Self {
            models: Vec::new(),
            skills: Vec::new(),
            commands: Vec::new(),
            capabilities: AgentCapabilities::none(),
            skills_error: None,
            configured_model: None,
            configured_effort: None,
            configured_service_tier: None,
            thread_model: None,
            thread_effort: None,
            cli_config_read: None,
            agent: None,
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
    /// 会话协议已接入。未接入时设置页不展示版本、更新和说明。
    pub session_linked: bool,
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
            session_linked: false,
        }
    }
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
        assert!(!parsed.supports_cancel);
        assert!(!parsed.supports_goals);
        assert!(!parsed.supports_plan);
        assert!(!parsed.changes.turn_diff);
        assert!(!parsed.changes.per_file_patch);
        assert!(!parsed.changes.git_scopes);
        assert!(!parsed.supports_review);
        assert!(!parsed.supports_network_access);
        assert!(!parsed.supports_writable_roots);
        assert!(!parsed.supports_permission_profiles);
        assert!(!parsed.supports_approve_for_me);
        assert!(!parsed.supports_paged_history);
        assert!(!parsed.supports_subscription_usage);
    }
}
