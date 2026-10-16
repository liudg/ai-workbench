import type { McpField, McpServerRow, McpSurface } from "@/types";

/**
 * 设置页文案。能对上 Codex 桌面 zh-CN（26.1007.9446）的用桌面中文。
 * 协议名保持英文：MCP、STDIO、HTTP、SSE、OAuth、CLI、JSON、URL、Headers、scope。
 * 对照笔记只留在开发记录里，不进界面。
 */
export const MCP_PAGE = {
  nav: "MCP 服务器",
  subtitle: "连接外部工具和数据来源",
  heading: "服务器",
  empty: "未连接 MCP 服务器",
  add: "添加服务器",
  titleNew: "连接至自定义 MCP",
  back: "返回",
  uninstall: "卸载",
  save: "保存",
  saveError: "无法保存 MCP 服务器",
  uninstallError: "无法卸载 MCP 服务器",
  switchNotice: "如需切换 MCP 服务器类型，请先卸载当前配置。",
  settings: "设置",
  authenticate: "进行身份验证",
  starting: "启动中…",
  enable: "启用",
  disable: "禁用",
  enabled: "已启用",
  disabled: "已禁用",
  typeLabel: "类型",
  typeAria: "MCP 服务器类型",
  name: "名称",
  key: "键",
  value: "值",
  removeEntry: "移除条目",
  cwd: "工作目录",
  envPassthrough: "环境变量传递",
  headers: "Headers",
  envHeaders: "来自环境变量的 Headers",
  env: "环境变量",
  args: "参数",
  command: "启动命令",
  url: "URL",
  bearer: "Bearer 令牌环境变量",
  registration: "OAuth 客户端注册",
  scopesPlaceholder: "要请求的 OAuth scope，用逗号分隔",
  authLabel: "认证",
  statusLabel: "状态",
  actionFailed: "操作未成功",
};

const REGISTRATION_LONG: Record<string, string> = {
  auto: "自动",
  cimd: "客户端 ID 元数据文档 (CIMD)",
  dcr: "动态客户端注册 (DCR)",
};

const ADD_LABEL: Record<string, string> = {
  args: "添加参数",
  env: "添加环境变量",
  headers: "添加 Header",
};

const AUTH_STATUS: Record<string, string> = {
  unsupported: "不支持",
  notLoggedIn: "未登录",
  bearer_token: "Bearer",
  bearerToken: "Bearer",
  oAuth: "OAuth",
  oauth: "OAuth",
  unknown: "未知",
};

export function existingTitle(name: string): string {
  return `更新 ${name} MCP`;
}

export function registrationLong(id: string): string {
  return REGISTRATION_LONG[id] ?? id;
}

export function registrationAria(id: string): string {
  return `OAuth 客户端注册：${registrationLong(id)}`;
}

export function authStatusLabel(status: string): string {
  if (!status) return "";
  return AUTH_STATUS[status] ?? status;
}

export function enabledLabel(enabled: boolean | null): string {
  if (enabled === true) return MCP_PAGE.enabled;
  if (enabled === false) return MCP_PAGE.disabled;
  return "";
}

export function statusTextLabel(text: string): string {
  const trimmed = text.trim();
  const bare = trimmed.replace(/^[√×✓✗]\s*/, "");
  if (bare === "Connected") return "已连接";
  if (bare === "Failed to connect") return "连接失败";
  if (bare === "ready") return "就绪";
  return trimmed;
}

export function rowStatusLine(surface: McpSurface, row: McpServerRow): string {
  return [
    row.transport ? transportLabel(surface, row.transport) : "",
    statusTextLabel(row.status_text),
    authStatusLabel(row.auth_status),
    enabledLabel(row.enabled),
  ]
    .filter(Boolean)
    .join(" · ");
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
