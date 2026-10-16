//! MCP 管理协议。前端只消费这些字段，不按 Agent 名字分支。

use serde::{Deserialize, Serialize};

use super::AgentKind;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpLabeled {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpField {
    pub id: String,
    pub label: String,
    /// 输入占位。空表示没有观察到占位文案。
    #[serde(default)]
    pub placeholder: String,
    /// `always`、`stdio`、`http`、`sse` 或 `http-sse`。
    pub when: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpVerbs {
    pub list: bool,
    pub add: bool,
    pub remove: bool,
    pub login: bool,
    pub logout: bool,
    pub enable: bool,
    pub disable: bool,
    pub list_tools: bool,
}

impl McpVerbs {
    pub fn none() -> Self {
        Self {
            list: false,
            add: false,
            remove: false,
            login: false,
            logout: false,
            enable: false,
            disable: false,
            list_tools: false,
        }
    }
}

/// 桌面里看到、但这个 Agent 的 CLI 做不到的项，或 CLI 有而桌面文案没看到的项。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpNote {
    pub label: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpSurface {
    pub kind: AgentKind,
    pub display_name: String,
    pub installed: bool,
    /// 已安装且本机 CLI 验证过至少一条 MCP 动词。
    pub manageable: bool,
    #[serde(default)]
    pub unavailable_reason: Option<String>,
    pub verbs: McpVerbs,
    pub transports: Vec<McpLabeled>,
    pub scopes: Vec<McpLabeled>,
    pub fields: Vec<McpField>,
    /// 登录按钮旁的 OAuth 注册策略。空则不显示。
    pub oauth_registration: Vec<McpLabeled>,
    /// `status`：`auth_status` 命中 `login_statuses`。
    /// `http`：传输是 http/sse，或地址以 http 开头。
    /// `always`：每一行都显示。动词为 false 时仍然不显示。
    /// `never`：不显示。
    pub login_rule: String,
    pub login_statuses: Vec<String>,
    /// 退出登录按钮的文案。空则不显示。桌面没看到按钮时，用 CLI 帮助里的说法。
    #[serde(default)]
    pub logout_label: String,
    /// scope 选择器的标签。空则不显示。
    #[serde(default)]
    pub scope_label: String,
    /// list-tools 按钮文案。空则不显示。
    #[serde(default)]
    pub tools_label: String,
    pub notes: Vec<McpNote>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpPair {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpAddSpec {
    pub name: String,
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<McpPair>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub bearer_token_env_var: String,
    #[serde(default)]
    pub headers: Vec<McpPair>,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    #[serde(default)]
    pub oauth_resource: String,
    #[serde(default)]
    pub callback_port: String,
    /// `auto`、`cimd`、`dcr` 或空。空表示不传注册策略。
    #[serde(default)]
    pub oauth_registration: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpServerRow {
    pub name: String,
    /// `stdio`、`streamable_http`、`sse` 或空。
    pub transport: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub bearer_token_env_var: String,
    #[serde(default)]
    pub enabled: Option<bool>,
    /// CLI 原值。桌面登录按钮只在 `notLoggedIn` 时出现。
    #[serde(default)]
    pub auth_status: String,
    /// CLI 列表里的状态原文。没有就空着。
    #[serde(default)]
    pub status_text: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub env: Vec<McpPair>,
    #[serde(default)]
    pub env_vars: Vec<String>,
    #[serde(default)]
    pub headers: Vec<McpPair>,
    #[serde(default)]
    pub env_headers: Vec<McpPair>,
}
