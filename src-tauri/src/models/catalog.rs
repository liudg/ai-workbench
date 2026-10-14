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
    /// 侧边栏 `thread/fork`。
    #[serde(default)]
    pub supports_fork: bool,
    /// 侧边栏 `thread/delete`。
    #[serde(default)]
    pub supports_delete: bool,
    /// 侧边栏 `thread/name/set`。
    #[serde(default)]
    pub supports_rename: bool,
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
            supports_fork: false,
            supports_delete: false,
            supports_rename: false,
            supports_plan: false,
            changes: ChangeCapabilities::none(),
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
            supports_goals: true,
            supports_images: true,
            supports_queue: true,
            supports_fork: true,
            supports_delete: true,
            supports_rename: true,
            supports_plan: true,
            changes: ChangeCapabilities::codex(),
            supports_review: true,
            supports_network_access: true,
            supports_writable_roots: true,
            supports_permission_profiles: false,
            supports_approve_for_me: false,
            supports_paged_history: true,
        }
    }

    /// Claude Code 会话能力。没有对应物的开关保持关闭，界面不要显示成已接通。
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
            supports_queue: false,
            supports_fork: false,
            supports_delete: false,
            supports_rename: true,
            supports_plan: true,
            changes: ChangeCapabilities {
                turn_diff: true,
                per_file_patch: true,
                git_scopes: true,
            },
            supports_review: false,
            supports_network_access: false,
            supports_writable_roots: false,
            supports_permission_profiles: false,
            supports_approve_for_me: false,
            supports_paged_history: true,
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
    }
}
