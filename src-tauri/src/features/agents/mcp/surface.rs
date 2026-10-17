//! 每个已验证 CLI 的管理面。界面文案对齐 Codex 桌面 zh-CN；协议名保持英文。
//! `notes` 只给测试留证据，界面不渲染。

use crate::models::{AgentKind, McpField, McpLabeled, McpNote, McpSurface, McpVerbs};

pub fn unverified(kind: AgentKind, display_name: &str, installed: bool) -> McpSurface {
    let reason = if installed {
        installed_without_mcp_reason(display_name)
    } else {
        not_installed_reason(display_name)
    };
    McpSurface {
        kind,
        display_name: display_name.to_string(),
        installed,
        manageable: false,
        unavailable_reason: Some(reason.into()),
        verbs: McpVerbs::none(),
        transports: Vec::new(),
        scopes: Vec::new(),
        fields: Vec::new(),
        oauth_registration: Vec::new(),
        login_rule: "never".into(),
        login_statuses: Vec::new(),
        logout_label: String::new(),
        scope_label: String::new(),
        tools_label: String::new(),
        notes: vec![note(
            "未验证",
            "不把没跑过的 CLI 写成不支持 MCP。",
        )],
    }
}

pub fn codex(installed: bool) -> McpSurface {
    McpSurface {
        kind: AgentKind::CodexCli,
        display_name: AgentKind::CodexCli.display_name().into(),
        installed,
        manageable: installed,
        unavailable_reason: (!installed).then(|| not_installed_reason(AgentKind::CodexCli.display_name())),
        verbs: McpVerbs {
            list: true,
            add: true,
            remove: true,
            login: true,
            logout: true,
            enable: true,
            disable: true,
            list_tools: false,
        },
        transports: vec![
            labeled("stdio", "STDIO"),
            labeled("streamable_http", "流式 HTTP"),
        ],
        scopes: Vec::new(),
        fields: vec![
            field("name", "名称", "MCP 服务器名称", "always", "text", true, "server-name"),
            field(
                "command",
                "启动命令",
                "openai-dev-mcp serve-sqlite",
                "stdio",
                "text",
                true,
                "command",
            ),
            field("args", "参数", "", "stdio", "list", false, "arg-list"),
            field("env", "环境变量", "", "stdio", "pairs", false, "pairs-env"),
            field("url", "URL", "https://mcp.example.com/mcp", "http", "text", true, "url"),
            field(
                "bearer_token_env_var",
                "Bearer 令牌环境变量",
                "MCP_BEARER_TOKEN",
                "http",
                "text",
                false,
                "env-name",
            ),
            field("client_id", "OAuth 客户端 ID", "", "http", "text", false, ""),
            field("client_secret", "OAuth 客户端密钥", "", "http", "secret", false, ""),
            field("oauth_resource", "OAuth 资源", "", "http", "text", false, ""),
        ],
        oauth_registration: registration(),
        login_rule: "status".into(),
        login_statuses: vec!["notLoggedIn".into()],
        logout_label: "取消认证".into(),
        scope_label: String::new(),
        tools_label: String::new(),
        notes: vec![
            note(
                "scope",
                "codex mcp add、remove、list、login 的帮助都没有 --scope。不显示 Configuration scope。",
            ),
            note(
                "sse",
                "add 只接受 stdio 命令或 --url。没有 sse。类型显示 STDIO 和流式 HTTP。",
            ),
            note(
                "Headers",
                "桌面有 Headers 和 Headers from environment variables。codex mcp add 帮助没有 --header。不提供编辑。",
            ),
            note(
                "Working directory",
                "桌面有 Working directory，占位 ~/code。list JSON 有 cwd，add 帮助没有对应旗标。有值时只读显示。",
            ),
            note(
                "Environment variable passthrough",
                "桌面有这项。list JSON 有 env_vars，add 帮助只有 --env KEY=VALUE。直通项只读，不提供编辑。",
            ),
            note(
                "Enable",
                "list JSON 和 config.toml 的 mcp_servers 都有 enabled，缺省为开。没有 enable 子命令，开关写配置里的 enabled。",
            ),
            note(
                "Authenticate",
                "桌面条件是 authStatus === \"notLoggedIn\"。隔离探测看到的 auth_status 是 unsupported 和 bearer_token。not_logged_in 未观察，不把下划线形式当成未登录。",
            ),
            note(
                "Deauthenticate",
                "logout 帮助写的是 deauthenticate。桌面设置页没有看到退出登录按钮，按钮文案未观察。",
            ),
            note(
                "--no-browser",
                "login 有 --no-browser。粘贴回调的界面未观察，调用时不传这个旗标。",
            ),
            note(
                "已有服务器",
                "没有 mcp update。同名 add 会再打印 Added global MCP server，不能当成已验证的替换。已有服务器只查看和 Uninstall。",
            ),
            note(
                "OAuth client identifier",
                "add 帮助有 --oauth-client-id、--oauth-client-secret、--oauth-resource。桌面添加表单没看到这三项，标签用帮助里的说法。",
            ),
        ],
    }
}

pub fn claude(installed: bool) -> McpSurface {
    McpSurface {
        kind: AgentKind::ClaudeCode,
        display_name: AgentKind::ClaudeCode.display_name().into(),
        installed,
        manageable: installed,
        unavailable_reason: (!installed)
            .then(|| not_installed_reason(AgentKind::ClaudeCode.display_name())),
        verbs: McpVerbs {
            list: true,
            add: true,
            remove: true,
            login: true,
            logout: true,
            enable: false,
            disable: false,
            list_tools: false,
        },
        transports: vec![
            labeled("stdio", "STDIO"),
            labeled("sse", "SSE"),
            labeled("http", "HTTP"),
        ],
        scopes: vec![
            labeled("local", "本地"),
            labeled("user", "用户"),
            labeled("project", "项目"),
        ],
        fields: vec![
            field("name", "名称", "MCP 服务器名称", "always", "text", true, "server-name"),
            field(
                "command",
                "启动命令",
                "openai-dev-mcp serve-sqlite",
                "stdio",
                "text",
                true,
                "command",
            ),
            field("args", "参数", "", "stdio", "list", false, "arg-list"),
            field("env", "环境变量", "", "stdio", "pairs", false, "pairs-env"),
            field("url", "URL", "https://mcp.example.com/mcp", "http-sse", "text", true, "url"),
            field("headers", "Headers", "", "http-sse", "pairs", false, "pairs-header"),
            field("client_id", "OAuth 客户端 ID", "", "http-sse", "text", false, ""),
            field("callback_port", "OAuth 回调端口", "", "http-sse", "text", false, "port"),
        ],
        oauth_registration: Vec::new(),
        login_rule: "http".into(),
        login_statuses: Vec::new(),
        logout_label: "清除已保存的 OAuth 凭据".into(),
        scope_label: "配置 scope".into(),
        tools_label: String::new(),
        notes: vec![
            note(
                "传输名",
                "claude mcp add 的传输 id 是 stdio、sse、http。界面显示 STDIO、SSE、HTTP。桌面类型开关是 STDIO 和流式 HTTP，没有 SSE。",
            ),
            note(
                "Configuration scope",
                "add 和 remove 有 -s/--scope，取值 local、user、project，默认 local。桌面表单没有 scope，控件和文案未观察。",
            ),
            note(
                "Bearer token env var",
                "claude mcp add 没有 --bearer-token-env-var。HTTP 认证用 -H/--header。",
            ),
            note(
                "OAuth client registration",
                "claude mcp login 帮助没有 --oauth-client-registration。不显示 Auto、CIMD、DCR。",
            ),
            note(
                "--client-secret",
                "这个旗标不接收值，会在终端提示，或读取 MCP_CLIENT_SECRET。不传。",
            ),
            note(
                "--no-browser",
                "login 帮助要求把重定向网址贴回终端。这个界面未观察，调用时不传。",
            ),
            note(
                "add-from-claude-desktop",
                "帮助写明 Mac and WSL only。本机是 Windows，不显示。",
            ),
            note(
                "list",
                "list 帮助没有 --json。按「名字: 命令 - 状态」解析。sse 行的形状未观察，以 http 开头的记为 http。",
            ),
            note(
                "remove",
                "不带 --scope 时从它所在的 scope 删除。列表行没有 scope，所以删除不带 -s。",
            ),
            note(
                "logout",
                "帮助是 Clear stored OAuth credentials。桌面没有看到这个按钮，文案未观察。",
            ),
            note(
                "add-json / serve / reset-project-choices",
                "add-json 与结构化 add 重叠，桌面没有 JSON 输入。serve 是把 Claude Code 自己变成 MCP 服务。reset-project-choices 作用于当前项目，管理进程的工作目录是临时目录，不能拿它改用户项目。这三项都不做按钮。",
            ),
            note(
                "Fixed port for OAuth callback",
                "add 有 --callback-port。桌面表单没看到，标签用帮助原文。",
            ),
        ],
    }
}

pub fn cursor(installed: bool) -> McpSurface {
    McpSurface {
        kind: AgentKind::CursorAgent,
        display_name: AgentKind::CursorAgent.display_name().into(),
        installed,
        manageable: installed,
        unavailable_reason: (!installed)
            .then(|| not_installed_reason(AgentKind::CursorAgent.display_name())),
        verbs: McpVerbs {
            list: true,
            add: false,
            remove: false,
            login: true,
            logout: false,
            enable: true,
            disable: true,
            list_tools: true,
        },
        transports: Vec::new(),
        scopes: Vec::new(),
        fields: Vec::new(),
        oauth_registration: Vec::new(),
        login_rule: "always".into(),
        login_statuses: Vec::new(),
        logout_label: String::new(),
        scope_label: String::new(),
        tools_label: "查看工具".into(),
        notes: vec![
            note(
                "add / remove",
                "agent mcp add 和 agent mcp remove 的帮助都退回父命令。父命令只有 login、list、list-tools、enable、disable。不显示 Add server 和 Uninstall。",
            ),
            note(
                "list",
                "没有 --json。探测到的行是「名字: ready」。没有命令和传输。ready 不是 notLoggedIn。",
            ),
            note(
                "Authenticate",
                "login 子命令存在，但列表里没看到未登录状态。状态门未观察，所以每一行都显示 Authenticate。",
            ),
            note(
                "Enable / Disable",
                "enable、disable 是两个子命令。列表状态 disabled 为关，ready 等其余非空状态为开，用开关而不是两个按钮。",
            ),
            note(
                "List available tools",
                "list-tools 的帮助是 List available tools and their argument names。桌面没有对应按钮，文案未观察。",
            ),
            note(
                "--trust",
                "在工作台仓库里直接跑 agent 会要求信任工作区。管理命令的工作目录是临时目录，不传 --trust。",
            ),
        ],
    }
}

fn registration() -> Vec<McpLabeled> {
    vec![
        labeled("auto", "自动"),
        labeled("cimd", "CIMD"),
        labeled("dcr", "DCR"),
    ]
}

fn labeled(id: &str, label: &str) -> McpLabeled {
    McpLabeled {
        id: id.into(),
        label: label.into(),
    }
}

fn field(
    id: &str,
    label: &str,
    placeholder: &str,
    when: &str,
    control: &str,
    required: bool,
    rule: &str,
) -> McpField {
    McpField {
        id: id.into(),
        label: label.into(),
        placeholder: placeholder.into(),
        when: when.into(),
        control: control.into(),
        required,
        rule: rule.into(),
    }
}

fn not_installed_reason(display_name: &str) -> String {
    format!("未检测到 {display_name}，安装后可在此管理 MCP。")
}

fn installed_without_mcp_reason(display_name: &str) -> String {
    format!("已检测到 {display_name}，暂无法在此管理 MCP。")
}

fn note(label: &str, reason: &str) -> McpNote {
    McpNote {
        label: label.into(),
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(surface: &McpSurface) -> Vec<&str> {
        surface.fields.iter().map(|field| field.id.as_str()).collect()
    }

    #[test]
    fn codex_hides_only_flags_missing_from_its_help() {
        let surface = codex(true);
        assert!(surface.manageable);
        assert!(surface.verbs.add && surface.verbs.login && surface.verbs.logout);
        assert!(surface.verbs.enable && surface.verbs.disable);
        assert!(!surface.verbs.list_tools);
        assert!(surface.scopes.is_empty());
        assert_eq!(
            surface
                .transports
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["stdio", "streamable_http"]
        );
        let fields = ids(&surface);
        assert!(fields.contains(&"bearer_token_env_var"));
        assert!(!fields.contains(&"headers"));
        assert!(!fields.contains(&"callback_port"));
        let command = surface.fields.iter().find(|field| field.id == "command").unwrap();
        assert_eq!(command.control, "text");
        assert!(command.required);
        assert_eq!(command.rule, "command");
        let secret = surface.fields.iter().find(|field| field.id == "client_secret").unwrap();
        assert_eq!(secret.control, "secret");
        assert!(!secret.required);
        assert_eq!(surface.login_rule, "status");
        assert_eq!(surface.login_statuses, vec!["notLoggedIn".to_string()]);
        assert!(surface.notes.iter().any(|item| item.label == "Headers"));
    }

    #[test]
    fn claude_keeps_scope_sse_and_headers() {
        let surface = claude(true);
        assert_eq!(
            surface
                .transports
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["stdio", "sse", "http"]
        );
        assert_eq!(surface.scopes.len(), 3);
        assert_eq!(surface.scope_label, "配置 scope");
        assert_eq!(surface.logout_label, "清除已保存的 OAuth 凭据");
        let headers = surface.fields.iter().find(|field| field.id == "headers").unwrap();
        assert_eq!(headers.control, "pairs");
        assert_eq!(headers.rule, "pairs-header");
        let port = surface.fields.iter().find(|field| field.id == "callback_port").unwrap();
        assert_eq!(port.rule, "port");
        assert!(!port.required);
        assert!(ids(&surface).contains(&"headers"));
        assert!(!ids(&surface).contains(&"bearer_token_env_var"));
        assert!(surface.oauth_registration.is_empty());
        assert_eq!(surface.login_rule, "http");
        assert!(surface.notes.iter().any(|item| item.label == "add-from-claude-desktop"));
    }

    #[test]
    fn cursor_has_no_add_or_remove() {
        let surface = cursor(true);
        assert!(!surface.verbs.add && !surface.verbs.remove && !surface.verbs.logout);
        assert!(surface.verbs.login && surface.verbs.enable && surface.verbs.disable);
        assert!(surface.verbs.list_tools);
        assert_eq!(surface.tools_label, "查看工具");
        assert!(surface.transports.is_empty());
        assert_eq!(surface.login_rule, "always");
        assert!(surface.notes.iter().any(|item| item.label == "add / remove"));
    }

    #[test]
    fn missing_cli_is_unverified_not_unsupported() {
        let surface = unverified(AgentKind::KimiCode, "Kimi Code", false);
        assert!(!surface.manageable);
        assert_eq!(surface.verbs, McpVerbs::none());
        let reason = surface.unavailable_reason.unwrap();
        assert_eq!(reason, "未检测到 Kimi Code，安装后可在此管理 MCP。");
        assert!(
            !reason.contains("未验证")
                && !reason.contains("未观察")
                && !reason.contains("动词")
                && !reason.contains("不支持")
                && !reason.contains("CLI")
        );
        let installed = unverified(AgentKind::KimiCode, "Kimi Code", true);
        let installed_reason = installed.unavailable_reason.unwrap();
        assert_eq!(installed_reason, "已检测到 Kimi Code，暂无法在此管理 MCP。");
        assert!(!installed_reason.contains("CLI") && !installed_reason.contains("未验证"));
        assert_eq!(
            codex(false).unavailable_reason.as_deref(),
            Some("未检测到 Codex CLI，安装后可在此管理 MCP。")
        );
    }
}
