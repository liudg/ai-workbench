import type { McpField, McpServerRow, McpSurface } from "@/types";

/**
 * 设置页文案。能对上 Codex 桌面 zh-CN 的用桌面中文。
 * 协议名保持英文：MCP、STDIO、HTTP、SSE、OAuth、JSON、URL、Headers。
 * 菜单文案是产品中文；显不显示由适配器的动词和规则决定，不按 Agent 名字分支。
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
  authenticate: "进行身份验证",
  enable: "启用",
  disable: "禁用",
  enabled: "已启用",
  disabled: "已禁用",
  connected: "已连接",
  configured: "已配置",
  loggedOut: "未登录",
  failed: "失败",
  authLabel: "认证",
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
  scopesPlaceholder: "要请求的 OAuth 权限范围，用逗号分隔",
  loading: "正在读取 MCP…",
  processing: "处理中…",
  saved: "已保存",
  removed: "已卸载",
  authStarted: "已开始身份验证",
  authCleared: "已取消认证",
  enableError: "无法启用",
  disableError: "无法禁用",
  loginError: "无法进行身份验证",
  logoutError: "无法取消认证",
  toolsError: "无法查看工具",
  listErrorTitle: "无法读取服务器",
  viewDetails: "查看详情",
  notInstalled: "未安装",
  authMenu: "身份验证",
  logoutMenu: "取消认证",
  toolsMenu: "查看工具",
  more: "更多操作",
  uninstallConfirmTitle: "卸载此 MCP 服务器？",
  cancel: "取消",
  showValue: "显示",
  hideValue: "隐藏",
  toolsHeading: "工具",
  toolsEmpty: "没有可用工具",
};

export const MASKED_VALUE = "••••••";

const DEV_REASON = /未观察|未验证|动词/;

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

export type McpAction = "save" | "remove" | "login" | "logout" | "enable" | "disable" | "tools";

export type McpFeedback =
  | { tone: "success"; text: string }
  | { tone: "failure"; title: string; detail: string };

export type McpStatusKind = "connected" | "configured" | "loggedOut" | "failed" | "disabled";

export type McpMenuId = "login" | "logout" | "tools" | "remove";

export interface McpMenuAction {
  id: McpMenuId;
  label: string;
}

export interface McpToolEntry {
  name: string;
  description: string;
}

export function failureTitle(action: McpAction): string {
  switch (action) {
    case "save":
      return MCP_PAGE.saveError;
    case "remove":
      return MCP_PAGE.uninstallError;
    case "login":
      return MCP_PAGE.loginError;
    case "logout":
      return MCP_PAGE.logoutError;
    case "enable":
      return MCP_PAGE.enableError;
    case "disable":
      return MCP_PAGE.disableError;
    case "tools":
      return MCP_PAGE.toolsError;
  }
}

export function successText(action: Exclude<McpAction, "tools">): string {
  switch (action) {
    case "save":
      return MCP_PAGE.saved;
    case "remove":
      return MCP_PAGE.removed;
    case "login":
      return MCP_PAGE.authStarted;
    case "logout":
      return MCP_PAGE.authCleared;
    case "enable":
      return MCP_PAGE.enabled;
    case "disable":
      return MCP_PAGE.disabled;
  }
}

export function uninstallConfirmBody(name: string): string {
  return `将移除「${name}」。`;
}

/** 后端笔记和开发口吻不进界面。空原因也不显示。 */
export function visibleUnavailableReason(reason: string | null | undefined): string | null {
  const text = reason?.trim() ?? "";
  if (!text || DEV_REASON.test(text)) return null;
  return text;
}

export function registrationLong(id: string): string {
  return REGISTRATION_LONG[id] ?? id;
}

export function registrationAria(id: string): string {
  return `OAuth 客户端注册：${registrationLong(id)}`;
}

export function rowStatus(row: McpServerRow): { kind: McpStatusKind; label: string } {
  if (row.enabled === false) return { kind: "disabled", label: MCP_PAGE.disabled };
  if (row.auth_status === "notLoggedIn") return { kind: "loggedOut", label: MCP_PAGE.loggedOut };
  if (isFailedStatus(row.status_text)) return { kind: "failed", label: MCP_PAGE.failed };
  if (isConnectedStatus(row.status_text)) return { kind: "connected", label: MCP_PAGE.connected };
  return { kind: "configured", label: MCP_PAGE.configured };
}

function isFailedStatus(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/[×✗]/.test(trimmed)) return true;
  const bare = trimmed.replace(/^[√×✓✗]\s*/, "");
  return bare === "Failed to connect" || /^failed\b/i.test(bare);
}

/** 只有列表原文写明已连接或就绪时才算连上。Codex 的 list 没有这项。 */
function isConnectedStatus(text: string): boolean {
  const bare = text.trim().replace(/^[√×✓✗]\s*/, "").toLowerCase();
  return bare === "connected" || bare === "ready";
}

/** 详情里的认证方式。空或未识别的原文不显示。 */
export function authMethodLabel(status: string): string | null {
  if (status === "unsupported") return "不支持";
  if (status === "bearer_token" || status === "bearerToken") return "Bearer";
  if (status === "oauth" || status === "oAuth") return "OAuth";
  return null;
}

export function menuDismissKey(key: string): boolean {
  return key === "Escape";
}

/** 列表上的传输标签。协议名只有 STDIO、HTTP、SSE。 */
export function transportTag(id: string): "STDIO" | "HTTP" | "SSE" | null {
  if (id === "stdio") return "STDIO";
  if (id === "sse") return "SSE";
  if (id === "http" || id === "streamable_http") return "HTTP";
  return null;
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

export function isRemoteTransport(row: McpServerRow): boolean {
  if (row.transport === "http" || row.transport === "streamable_http" || row.transport === "sse") {
    return true;
  }
  return row.url.startsWith("http://") || row.url.startsWith("https://");
}

export function showLogin(surface: McpSurface, row: McpServerRow): boolean {
  if (!surface.manageable || !surface.verbs.login) return false;
  if (surface.login_rule === "always") return true;
  if (surface.login_rule === "never") return false;
  if (surface.login_rule === "status") {
    if (surface.login_statuses.includes(row.auth_status)) return true;
    // 新加的 HTTP/SSE 常是 unknown。有登录动词时试一次没有副作用。
    return row.auth_status === "unknown" && isRemoteTransport(row);
  }
  if (surface.login_rule === "http") {
    return isRemoteTransport(row);
  }
  return false;
}

/** 登录需要注册方式或 scope 时先打开选项，不直接发起。 */
export function loginLaunch(surface: McpSurface, row: McpServerRow): "hidden" | "direct" | "options" {
  if (!showLogin(surface, row)) return "hidden";
  return loginNeedsOptions(surface) ? "options" : "direct";
}

export function showAdd(surface: McpSurface): boolean {
  return surface.manageable && surface.verbs.add;
}

export function showRemove(surface: McpSurface): boolean {
  return surface.manageable && surface.verbs.remove;
}

export function showToggle(surface: McpSurface, row: McpServerRow): boolean {
  if (!surface.manageable || row.enabled === null || row.enabled === undefined) return false;
  return surface.verbs.enable || surface.verbs.disable;
}

/** 开关要切到 `enabled` 的反方向时，对应动词是否存在。 */
export function toggleNextAllowed(surface: McpSurface, enabled: boolean): boolean {
  return enabled ? surface.verbs.disable : surface.verbs.enable;
}

export function loginNeedsOptions(surface: McpSurface): boolean {
  return surface.oauth_registration.length > 0 || showLoginScopes(surface);
}

export function menuActions(surface: McpSurface, row: McpServerRow): McpMenuAction[] {
  const items: McpMenuAction[] = [];
  if (showLogin(surface, row)) items.push({ id: "login", label: MCP_PAGE.authMenu });
  if (surface.manageable && surface.verbs.logout && surface.logout_label.trim()) {
    items.push({ id: "logout", label: MCP_PAGE.logoutMenu });
  }
  if (surface.manageable && surface.verbs.list_tools && surface.tools_label.trim()) {
    items.push({ id: "tools", label: MCP_PAGE.toolsMenu });
  }
  if (showRemove(surface)) items.push({ id: "remove", label: MCP_PAGE.uninstall });
  return items;
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

/** 把 list-tools 原文拆成名称和说明。认不出的行整行当作名称，不丢内容。 */
export function parseToolList(text: string): McpToolEntry[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const json = parseToolJson(trimmed);
  if (json) return json;
  const entries: McpToolEntry[] = [];
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*•]\s+/, "");
    if (!line || /^tools\b/i.test(line) || /^available tools\b/i.test(line)) continue;
    const colon = line.match(/^([A-Za-z0-9_.:/-]+)\s*[:：]\s+(.+)$/);
    if (colon) {
      entries.push({ name: colon[1], description: colon[2].trim() });
      continue;
    }
    const dash = line.match(/^([A-Za-z0-9_.:/-]+)\s+[-–—]\s+(.+)$/);
    if (dash) {
      entries.push({ name: dash[1], description: dash[2].trim() });
      continue;
    }
    entries.push({ name: line, description: "" });
  }
  return entries;
}

function parseToolJson(text: string): McpToolEntry[] | null {
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { tools?: unknown }).tools)
      ? (value as { tools: unknown[] }).tools
      : null;
  if (!list) return null;
  const entries: McpToolEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as { name?: unknown; description?: unknown };
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) continue;
    const description = typeof record.description === "string" ? record.description.trim() : "";
    entries.push({ name, description });
  }
  return entries;
}
