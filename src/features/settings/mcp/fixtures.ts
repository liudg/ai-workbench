import type { McpServerRow, McpSurface, McpVerbs } from "@/types";

const none: McpVerbs = {
  list: false,
  add: false,
  remove: false,
  login: false,
  logout: false,
  enable: false,
  disable: false,
  list_tools: false,
};

function row(patch: Partial<McpServerRow>): McpServerRow {
  return {
    name: "demo",
    transport: "",
    command: "",
    args: [],
    url: "",
    bearer_token_env_var: "",
    enabled: null,
    auth_status: "",
    status_text: "",
    scope: "",
    cwd: "",
    env: [],
    env_vars: [],
    headers: [],
    env_headers: [],
    ...patch,
  };
}

export const codexSurface: McpSurface = {
  kind: "codex-cli",
  display_name: "Codex CLI",
  installed: true,
  manageable: true,
  unavailable_reason: null,
  verbs: {
    ...none,
    list: true,
    add: true,
    remove: true,
    login: true,
    logout: true,
    enable: true,
    disable: true,
  },
  transports: [
    { id: "stdio", label: "STDIO" },
    { id: "streamable_http", label: "流式 HTTP" },
  ],
  scopes: [],
  fields: [
    { id: "name", label: "名称", placeholder: "MCP 服务器名称", when: "always", control: "text", required: true, rule: "server-name" },
    { id: "command", label: "启动命令", placeholder: "openai-dev-mcp serve-sqlite", when: "stdio", control: "text", required: true, rule: "command" },
    { id: "args", label: "参数", placeholder: "", when: "stdio", control: "list", required: false, rule: "arg-list" },
    { id: "env", label: "环境变量", placeholder: "", when: "stdio", control: "pairs", required: false, rule: "pairs-env" },
    { id: "url", label: "URL", placeholder: "https://mcp.example.com/mcp", when: "http", control: "text", required: true, rule: "url" },
    { id: "bearer_token_env_var", label: "Bearer 令牌环境变量", placeholder: "MCP_BEARER_TOKEN", when: "http", control: "text", required: false, rule: "env-name" },
    { id: "client_id", label: "OAuth 客户端 ID", placeholder: "", when: "http", control: "text", required: false, rule: "" },
    { id: "client_secret", label: "OAuth 客户端密钥", placeholder: "", when: "http", control: "secret", required: false, rule: "" },
    { id: "oauth_resource", label: "OAuth 资源", placeholder: "", when: "http", control: "text", required: false, rule: "" },
  ],
  oauth_registration: [
    { id: "auto", label: "自动" },
    { id: "cimd", label: "CIMD" },
    { id: "dcr", label: "DCR" },
  ],
  login_rule: "status",
  login_statuses: ["not_logged_in", "notLoggedIn"],
  logout_label: "取消认证",
  scope_label: "",
  tools_label: "",
  notes: [
    { label: "Headers", reason: "codex mcp add 帮助没有 --header。不提供编辑。" },
    { label: "Enable", reason: "list JSON 和 config.toml 有 enabled。开关写配置里的 enabled。" },
    { label: "Authenticate", reason: "auth_status 为 not_logged_in（CLI）或 notLoggedIn（app-server）时显示。" },
  ],
};

export const claudeSurface: McpSurface = {
  kind: "claude-code",
  display_name: "Claude Code",
  installed: true,
  manageable: true,
  unavailable_reason: null,
  verbs: { ...none, list: true, add: true, remove: true, login: true, logout: true },
  transports: [
    { id: "stdio", label: "STDIO" },
    { id: "sse", label: "SSE" },
    { id: "http", label: "HTTP" },
  ],
  scopes: [{ id: "user", label: "用户" }],
  fields: [
    { id: "name", label: "名称", placeholder: "MCP 服务器名称", when: "always", control: "text", required: true, rule: "server-name" },
    { id: "command", label: "启动命令", placeholder: "openai-dev-mcp serve-sqlite", when: "stdio", control: "text", required: true, rule: "command" },
    { id: "args", label: "参数", placeholder: "", when: "stdio", control: "list", required: false, rule: "arg-list" },
    { id: "env", label: "环境变量", placeholder: "", when: "stdio", control: "pairs", required: false, rule: "pairs-env" },
    { id: "url", label: "URL", placeholder: "https://mcp.example.com/mcp", when: "http-sse", control: "text", required: true, rule: "url" },
    { id: "headers", label: "Headers", placeholder: "", when: "http-sse", control: "pairs", required: false, rule: "pairs-header" },
    { id: "client_id", label: "OAuth 客户端 ID", placeholder: "", when: "http-sse", control: "text", required: false, rule: "" },
    { id: "callback_port", label: "OAuth 回调端口", placeholder: "", when: "http-sse", control: "text", required: false, rule: "port" },
  ],
  oauth_registration: [],
  login_rule: "http",
  login_statuses: [],
  logout_label: "清除已保存的 OAuth 凭据",
  scope_label: "配置 scope",
  tools_label: "",
  notes: [
    { label: "传输名", reason: "CLI 是 stdio、sse、http。桌面开关没有 sse。" },
    { label: "Configuration scope", reason: "管理命令在临时目录里跑，local 和 project 用不上，只给 user。" },
  ],
};

export const cursorSurface: McpSurface = {
  kind: "cursor-agent",
  display_name: "Cursor Agent",
  installed: true,
  manageable: true,
  unavailable_reason: null,
  verbs: { ...none, list: true, login: true, enable: true, disable: true, list_tools: true },
  transports: [],
  scopes: [],
  fields: [],
  oauth_registration: [],
  login_rule: "always",
  login_statuses: [],
  logout_label: "",
  scope_label: "",
  tools_label: "查看工具",
  notes: [
    { label: "add / remove", reason: "agent mcp 没有 add 和 remove。不显示 Add server 和 Uninstall。" },
    { label: "Authenticate", reason: "列表里没看到未登录状态。每一行都显示 Authenticate。" },
  ],
};

export const unverifiedSurface: McpSurface = {
  kind: "kimi-code",
  display_name: "Kimi Code",
  installed: false,
  manageable: false,
  unavailable_reason: "未检测到 Kimi Code，安装后可在此管理 MCP。",
  verbs: none,
  transports: [],
  scopes: [],
  fields: [],
  oauth_registration: [],
  login_rule: "never",
  login_statuses: [],
  logout_label: "",
  scope_label: "",
  tools_label: "",
  notes: [{ label: "未验证", reason: "不把没跑过的 CLI 写成不支持 MCP。" }],
};

export const previewSurfaces: McpSurface[] = [codexSurface, claudeSurface, cursorSurface, unverifiedSurface];

export const codexRows: McpServerRow[] = [
  row({
    name: "wb-mcp-probe",
    transport: "stdio",
    command: "cmd",
    args: ["/c", "echo", "wb-mcp-probe"],
    enabled: true,
    auth_status: "unsupported",
  }),
  row({
    name: "wb-mcp-http",
    transport: "streamable_http",
    url: "https://example.invalid/mcp",
    bearer_token_env_var: "MCP_BEARER_TOKEN",
    enabled: true,
    auth_status: "bearer_token",
  }),
];

export const loginRow: McpServerRow = row({
  name: "wb-mcp-oauth",
  transport: "streamable_http",
  url: "https://example.invalid/mcp",
  enabled: true,
  auth_status: "not_logged_in",
});

export const claudeRows: McpServerRow[] = [
  row({
    name: "wb-mcp-probe",
    transport: "stdio",
    command: "cmd /c echo wb-mcp-probe",
    status_text: '✘ Failed to connect — MCP server "wb-mcp-probe" connection timed out after 30000ms',
  }),
  row({
    name: "wb-mcp-http",
    transport: "http",
    url: "https://example.invalid/mcp",
    status_text: "✔ Connected",
  }),
  row({
    name: "claude.ai Claude Docs",
    transport: "http",
    url: "https://api.anthropic.com/v1/pages/mcp",
    status_text: "⚠ Needs authentication",
  }),
];

export const cursorRows: McpServerRow[] = [
  row({ name: "demo-ready", status_text: "ready", enabled: true }),
  row({ name: "demo-other", status_text: "disabled", enabled: false }),
];
