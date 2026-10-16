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
  verbs: { ...none, list: true, add: true, remove: true, login: true, logout: true },
  transports: [
    { id: "stdio", label: "STDIO" },
    { id: "streamable_http", label: "Streamable HTTP" },
  ],
  scopes: [],
  fields: [
    { id: "name", label: "Name", placeholder: "MCP server name", when: "always" },
    { id: "command", label: "Command to launch", placeholder: "openai-dev-mcp serve-sqlite", when: "stdio" },
    { id: "args", label: "Arguments", placeholder: "", when: "stdio" },
    { id: "env", label: "Environment variables", placeholder: "", when: "stdio" },
    { id: "url", label: "URL", placeholder: "https://mcp.example.com/mcp", when: "http" },
    { id: "bearer_token_env_var", label: "Bearer token env var", placeholder: "MCP_BEARER_TOKEN", when: "http" },
    { id: "client_id", label: "OAuth client identifier", placeholder: "", when: "http" },
    { id: "client_secret", label: "OAuth client secret", placeholder: "", when: "http" },
    { id: "oauth_resource", label: "OAuth resource", placeholder: "", when: "http" },
  ],
  oauth_registration: [
    { id: "auto", label: "Auto" },
    { id: "cimd", label: "CIMD" },
    { id: "dcr", label: "DCR" },
  ],
  login_rule: "status",
  login_statuses: ["notLoggedIn"],
  logout_label: "Deauthenticate",
  scope_label: "",
  tools_label: "",
  notes: [
    { label: "Headers", reason: "codex mcp add 帮助没有 --header。不提供编辑。" },
    { label: "Enable", reason: "没有 enable 或 disable 子命令。不显示开关。" },
    { label: "Authenticate", reason: "只在 auth_status 为 notLoggedIn 时显示。not_logged_in 未观察。" },
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
    { id: "stdio", label: "stdio" },
    { id: "sse", label: "sse" },
    { id: "http", label: "http" },
  ],
  scopes: [
    { id: "local", label: "local" },
    { id: "user", label: "user" },
    { id: "project", label: "project" },
  ],
  fields: [
    { id: "name", label: "Name", placeholder: "MCP server name", when: "always" },
    { id: "command", label: "Command to launch", placeholder: "openai-dev-mcp serve-sqlite", when: "stdio" },
    { id: "args", label: "Arguments", placeholder: "", when: "stdio" },
    { id: "env", label: "Environment variables", placeholder: "", when: "stdio" },
    { id: "url", label: "URL", placeholder: "https://mcp.example.com/mcp", when: "http-sse" },
    { id: "headers", label: "Headers", placeholder: "", when: "http-sse" },
    { id: "client_id", label: "OAuth client ID", placeholder: "", when: "http-sse" },
    { id: "callback_port", label: "Fixed port for OAuth callback", placeholder: "", when: "http-sse" },
  ],
  oauth_registration: [],
  login_rule: "http",
  login_statuses: [],
  logout_label: "Clear stored OAuth credentials",
  scope_label: "Configuration scope",
  tools_label: "",
  notes: [
    { label: "传输名", reason: "CLI 是 stdio、sse、http。桌面开关没有 sse。" },
    { label: "Configuration scope", reason: "桌面表单没有 scope，文案未观察。" },
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
  tools_label: "List available tools",
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
  unavailable_reason: "本机没有该 CLI，MCP 动词未验证。",
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
  auth_status: "notLoggedIn",
});

export const claudeRows: McpServerRow[] = [
  row({
    name: "wb-mcp-probe",
    transport: "stdio",
    command: "cmd /c echo wb-mcp-probe",
    status_text: "× Failed to connect",
  }),
  row({
    name: "wb-mcp-http",
    transport: "http",
    url: "https://example.invalid/mcp",
    command: "https://example.invalid/mcp",
    status_text: "√ Connected",
  }),
];

export const cursorRows: McpServerRow[] = [
  row({ name: "demo-ready", status_text: "ready" }),
  row({ name: "demo-other", status_text: "ready" }),
];
