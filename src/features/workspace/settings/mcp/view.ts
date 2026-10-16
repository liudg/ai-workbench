import type { McpField, McpServerRow, McpSurface } from "@/types";

/** Codex 桌面 `app.asar` 里看到的原文。 */
export const MCP_PAGE = {
  nav: "MCPs",
  subtitle: "Connect external tools and data sources",
  heading: "Servers",
  empty: "No MCP servers connected",
  add: "Add server",
  titleNew: "Connect to a custom MCP",
  back: "Back",
  uninstall: "Uninstall",
  save: "Save",
  saveError: "Could not save MCP server",
  uninstallError: "Could not uninstall MCP server",
  switchNotice: "If you would like to switch MCP server type, please uninstall first.",
  settings: "Settings",
  authenticate: "Authenticate",
  starting: "Starting…",
  enable: "Enable",
  disable: "Disable",
  typeLabel: "Type",
  typeAria: "MCP server type",
  name: "Name",
  key: "Key",
  value: "Value",
  removeEntry: "Remove entry",
  cwd: "Working directory",
  envPassthrough: "Environment variable passthrough",
  headers: "Headers",
  envHeaders: "Headers from environment variables",
  env: "Environment variables",
  args: "Arguments",
  command: "Command to launch",
  url: "URL",
  bearer: "Bearer token env var",
};

export const PAGE_NOTES = [
  {
    label: "导航标题",
    reason: "slug mcp-settings 的导航标题未观察。导航用已看到的标签 MCPs。",
  },
  {
    label: "空列表",
    reason:
      "空状态用 settings.mcp.empty「No MCP servers connected」。同包还有「No MCP servers found」，manageOnly 实际用哪一句未观察。",
  },
  {
    label: "Docs",
    reason: "看到 Docs 和 Open MCP documentation。链接地址未观察，不放置链接。",
  },
  {
    label: "Restart",
    reason: "桌面 Restart 会重启 Codex Electron。CLI 没有这个动词，工作台不重启已打开的窗口。",
  },
  {
    label: "Clear all app data",
    reason: "桌面清的是 Electron 里 MCP Apps 的浏览器数据。CLI 没有这个动词。",
  },
  {
    label: "From plugins",
    reason: "桌面有 From plugins。CLI 列表没有分开插件服务器，分组方式未观察。",
  },
  {
    label: "scopes",
    reason:
      "codex mcp login 有 --scopes。桌面 Authenticate 旁边没看到 scopes 输入，标签用帮助原文。只在带 OAuth client registration 的管理面上显示。",
  },
];

const REGISTRATION_LONG: Record<string, string> = {
  auto: "Automatic",
  cimd: "Client ID metadata document (CIMD)",
  dcr: "Dynamic client registration (DCR)",
};

const ADD_LABEL: Record<string, string> = {
  args: "Add argument",
  env: "Add environment variable",
  headers: "Add header",
};

export function existingTitle(name: string): string {
  return `Update ${name} MCP`;
}

export function registrationLong(id: string): string {
  return REGISTRATION_LONG[id] ?? id;
}

export function registrationAria(id: string): string {
  return `OAuth client registration: ${registrationLong(id)}`;
}

export function addLabel(fieldId: string): string | null {
  return ADD_LABEL[fieldId] ?? null;
}

export function fieldVisible(when: string, transport: string): boolean {
  if (when === "always") return true;
  if (when === "stdio") return transport === "stdio";
  if (when === "sse") return transport === "sse";
  const http = transport === "http" || transport === "streamable_http";
  if (when === "http") return http;
  if (when === "http-sse") return http || transport === "sse";
  return false;
}

export function visibleFields(fields: McpField[], transport: string): McpField[] {
  return fields.filter((field) => fieldVisible(field.when, transport));
}

export function showLogin(surface: McpSurface, row: McpServerRow): boolean {
  if (!surface.manageable || !surface.verbs.login) return false;
  if (surface.login_rule === "always") return true;
  if (surface.login_rule === "never") return false;
  if (surface.login_rule === "status") {
    return surface.login_statuses.includes(row.auth_status);
  }
  if (surface.login_rule === "http") {
    if (row.transport === "http" || row.transport === "streamable_http" || row.transport === "sse") {
      return true;
    }
    return row.url.startsWith("http://") || row.url.startsWith("https://");
  }
  return false;
}

export function showAdd(surface: McpSurface): boolean {
  return surface.manageable && surface.verbs.add;
}

export function showRemove(surface: McpSurface): boolean {
  return surface.manageable && surface.verbs.remove;
}

export function transportLabel(surface: McpSurface, id: string): string {
  return surface.transports.find((item) => item.id === id)?.label ?? id;
}

export function defaultTransport(surface: McpSurface): string {
  return surface.transports[0]?.id ?? "";
}

export function defaultScope(surface: McpSurface): string {
  return surface.scopes.find((item) => item.id === "local")?.id ?? surface.scopes[0]?.id ?? "";
}

export function showRegistration(surface: McpSurface, transport: string): boolean {
  return surface.oauth_registration.length > 0 && fieldVisible("http", transport);
}

export function showLoginScopes(surface: McpSurface): boolean {
  return surface.oauth_registration.length > 0;
}
