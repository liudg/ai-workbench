import assert from "node:assert/strict";
import { test } from "node:test";

import type { McpServerRow, McpSurface } from "@/types";
import {
  MCP_PAGE,
  failureTitle,
  fieldVisible,
  loginNeedsOptions,
  menuActions,
  parseToolList,
  authMethodLabel,
  menuDismissKey,
  registrationAria,
  rowStatus,
  withRowBusy,
  withoutRowBusy,
  showAdd,
  showLogin,
  showRemove,
  showToggle,
  successText,
  toggleNextAllowed,
  transportTag,
  uninstallConfirmBody,
  visibleFields,
  visibleUnavailableReason,
} from "./view.ts";

function surface(patch: Partial<McpSurface>): McpSurface {
  return {
    kind: "codex-cli",
    display_name: "Codex CLI",
    installed: true,
    manageable: true,
    unavailable_reason: null,
    verbs: {
      list: true,
      add: true,
      remove: true,
      login: true,
      logout: true,
      enable: false,
      disable: false,
      list_tools: false,
    },
    transports: [
      { id: "stdio", label: "STDIO" },
      { id: "streamable_http", label: "Streamable HTTP" },
    ],
    scopes: [],
    fields: [
      { id: "name", label: "Name", placeholder: "MCP server name", when: "always" },
      { id: "command", label: "Command to launch", placeholder: "", when: "stdio" },
      { id: "url", label: "URL", placeholder: "", when: "http" },
      { id: "headers", label: "Headers", placeholder: "", when: "http-sse" },
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
    notes: [],
    ...patch,
  };
}

function row(patch: Partial<McpServerRow>): McpServerRow {
  return {
    name: "demo",
    transport: "stdio",
    command: "cmd",
    args: [],
    url: "",
    bearer_token_env_var: "",
    enabled: true,
    auth_status: "unsupported",
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

test("settings copy stays product Chinese and keeps protocol names", () => {
  assert.equal(MCP_PAGE.nav, "MCP 服务器");
  assert.equal(MCP_PAGE.subtitle, "连接外部工具和数据来源");
  assert.equal(MCP_PAGE.empty, "未连接 MCP 服务器");
  assert.equal(MCP_PAGE.add, "添加服务器");
  assert.equal(MCP_PAGE.titleNew, "连接至自定义 MCP");
  assert.equal(MCP_PAGE.authenticate, "进行身份验证");
  assert.equal(MCP_PAGE.headers, "Headers");
  assert.equal(MCP_PAGE.authMenu, "身份验证");
  assert.equal(MCP_PAGE.logoutMenu, "取消认证");
  assert.equal(MCP_PAGE.toolsMenu, "查看工具");
  assert.equal(MCP_PAGE.notInstalled, "未安装");
  assert.equal(MCP_PAGE.viewDetails, "查看详情");
  assert.equal(MCP_PAGE.processing, "处理中…");
  assert.equal(MCP_PAGE.connected, "已连接");
  assert.equal(MCP_PAGE.configured, "已配置");
  assert.equal(MCP_PAGE.authLabel, "认证");
  assert.equal(MCP_PAGE.scopesPlaceholder, "要请求的 OAuth 权限范围，用逗号分隔");
  assert.equal(MCP_PAGE.loggedOut, "未登录");
  assert.equal(MCP_PAGE.failed, "失败");
  assert.equal(MCP_PAGE.disabled, "已禁用");
  assert.equal(registrationAria("auto"), "OAuth 客户端注册：自动");
  assert.equal(uninstallConfirmBody("demo"), "将移除「demo」。");
  for (const text of Object.values(MCP_PAGE)) {
    assert.equal(text.includes("未观察"), false, text);
    assert.equal(text.includes("未验证"), false, text);
    assert.equal(text.includes("动词"), false, text);
    assert.equal(text.includes("卸载失败"), false, text);
    assert.equal(text.includes("如需切换"), false, text);
  }
});

test("failure titles match the action and success text is short Chinese", () => {
  assert.equal(failureTitle("enable"), "无法启用");
  assert.equal(failureTitle("disable"), "无法禁用");
  assert.notEqual(failureTitle("disable"), failureTitle("enable"));
  assert.equal(failureTitle("login"), "无法进行身份验证");
  assert.equal(failureTitle("logout"), "无法取消认证");
  assert.equal(failureTitle("save"), "无法保存 MCP 服务器");
  assert.equal(failureTitle("remove"), "无法卸载 MCP 服务器");
  assert.equal(successText("save"), "已保存");
  assert.equal(successText("remove"), "已卸载");
  assert.equal(successText("enable"), "已启用");
  assert.equal(successText("disable"), "已禁用");
  assert.equal(successText("login"), "已开始身份验证");
  assert.equal(successText("save").includes("Added"), false);
});

test("row status stays configured until the list explicitly says connected or ready", () => {
  assert.deepEqual(rowStatus(row({})), { kind: "configured", label: "已配置" });
  assert.deepEqual(rowStatus(row({ auth_status: "unsupported", status_text: "" })), {
    kind: "configured",
    label: "已配置",
  });
  assert.deepEqual(rowStatus(row({ auth_status: "bearer_token" })), { kind: "configured", label: "已配置" });
  assert.deepEqual(rowStatus(row({ enabled: false, auth_status: "notLoggedIn", status_text: "√ Connected" })), {
    kind: "disabled",
    label: "已禁用",
  });
  assert.deepEqual(rowStatus(row({ auth_status: "notLoggedIn" })), { kind: "loggedOut", label: "未登录" });
  assert.deepEqual(rowStatus(row({ auth_status: "not_logged_in" })), { kind: "configured", label: "已配置" });
  assert.deepEqual(rowStatus(row({ enabled: null, status_text: "× Failed to connect", auth_status: "" })), {
    kind: "failed",
    label: "失败",
  });
  assert.deepEqual(rowStatus(row({ enabled: null, status_text: "√ Connected", auth_status: "" })), {
    kind: "connected",
    label: "已连接",
  });
  assert.deepEqual(rowStatus(row({ enabled: null, status_text: "ready", auth_status: "", transport: "" })), {
    kind: "connected",
    label: "已连接",
  });
  assert.equal(authMethodLabel("unsupported"), "不支持");
  assert.equal(authMethodLabel("bearer_token"), "Bearer");
  assert.equal(authMethodLabel("oAuth"), "OAuth");
  assert.equal(authMethodLabel("notLoggedIn"), null);
  assert.equal(authMethodLabel(""), null);
});

test("row busy clears only the finished name, and Escape closes the menu", () => {
  const both = withRowBusy(withRowBusy(new Set<string>(), "alpha"), "beta");
  assert.deepEqual([...both].sort(), ["alpha", "beta"]);
  assert.deepEqual([...withoutRowBusy(both, "alpha")], ["beta"]);
  assert.equal(withoutRowBusy(both, "missing"), both);
  assert.equal(menuDismissKey("Escape"), true);
  assert.equal(menuDismissKey("Enter"), false);
});

test("transport tags stay STDIO, HTTP, and SSE", () => {
  assert.equal(transportTag("stdio"), "STDIO");
  assert.equal(transportTag("streamable_http"), "HTTP");
  assert.equal(transportTag("http"), "HTTP");
  assert.equal(transportTag("sse"), "SSE");
  assert.equal(transportTag(""), null);
});

test("toggle follows enabled and verbs, menu follows verbs", () => {
  const codex = surface({});
  assert.equal(showToggle(codex, row({ enabled: true })), false);
  assert.equal(showToggle(codex, row({ enabled: null })), false);

  const cursor = surface({
    kind: "cursor-agent",
    verbs: { ...surface({}).verbs, add: false, remove: false, logout: false, enable: true, disable: true, list_tools: true },
    logout_label: "",
    tools_label: "查看工具",
    oauth_registration: [],
    login_rule: "always",
  });
  assert.equal(showToggle(cursor, row({ enabled: null })), false);
  assert.equal(showToggle(cursor, row({ enabled: true })), true);
  assert.equal(showToggle(cursor, row({ enabled: false })), true);
  assert.equal(toggleNextAllowed(cursor, true), true);
  assert.equal(toggleNextAllowed(cursor, false), true);
  assert.deepEqual(
    menuActions(cursor, row({ auth_status: "", enabled: null })).map((item) => item.label),
    ["身份验证", "查看工具"],
  );

  const claude = surface({
    kind: "claude-code",
    login_rule: "http",
    login_statuses: [],
    oauth_registration: [],
    logout_label: "清除已保存的 OAuth 凭据",
  });
  assert.deepEqual(
    menuActions(claude, row({ transport: "http", url: "https://example.invalid/mcp" })).map((item) => item.id),
    ["login", "logout", "remove"],
  );
  assert.deepEqual(menuActions(claude, row({ transport: "stdio" })).map((item) => item.id), ["logout", "remove"]);
  assert.equal(loginNeedsOptions(claude), false);
  assert.equal(loginNeedsOptions(codex), true);
});

test("developer reasons never become the unavailable sentence", () => {
  assert.equal(visibleUnavailableReason("本机没有该 CLI，MCP 动词未验证。"), null);
  assert.equal(visibleUnavailableReason("状态未观察，不显示。"), null);
  assert.equal(visibleUnavailableReason("  "), null);
  assert.equal(
    visibleUnavailableReason("未检测到 Kimi Code，安装后可在此管理 MCP。"),
    "未检测到 Kimi Code，安装后可在此管理 MCP。",
  );
});

test("tool list splits name and description", () => {
  assert.deepEqual(parseToolList(""), []);
  assert.deepEqual(parseToolList('[{"name":"echo","description":"回声"}]'), [{ name: "echo", description: "回声" }]);
  assert.deepEqual(parseToolList('{"tools":[{"name":"ping","description":"探测"}]}'), [
    { name: "ping", description: "探测" },
  ]);
  assert.deepEqual(parseToolList("- echo: 回声\nread_file - 读取文件\nonly_name"), [
    { name: "echo", description: "回声" },
    { name: "read_file", description: "读取文件" },
    { name: "only_name", description: "" },
  ]);
});

test("field visibility follows the transport token on the surface", () => {
  const fields = surface({}).fields;
  assert.deepEqual(
    visibleFields(fields, "stdio").map((field) => field.id),
    ["name", "command"],
  );
  assert.deepEqual(
    visibleFields(fields, "streamable_http").map((field) => field.id),
    ["name", "url", "headers"],
  );
  assert.equal(fieldVisible("sse", "sse"), true);
  assert.equal(fieldVisible("http", "sse"), false);
});

test("authenticate follows the surface rule and ignores unseen status spellings", () => {
  const codex = surface({});
  assert.equal(showLogin(codex, row({ auth_status: "unsupported" })), false);
  assert.equal(showLogin(codex, row({ auth_status: "bearer_token" })), false);
  assert.equal(showLogin(codex, row({ auth_status: "not_logged_in" })), false);
  assert.equal(showLogin(codex, row({ auth_status: "notLoggedIn" })), true);

  const claude = surface({
    kind: "claude-code",
    login_rule: "http",
    login_statuses: [],
    oauth_registration: [],
  });
  assert.equal(showLogin(claude, row({ transport: "stdio" })), false);
  assert.equal(showLogin(claude, row({ transport: "http", url: "https://example.invalid/mcp" })), true);
  assert.equal(showLogin(claude, row({ transport: "sse" })), true);

  const cursor = surface({
    kind: "cursor-agent",
    login_rule: "always",
    login_statuses: [],
    oauth_registration: [],
    verbs: { ...surface({}).verbs, add: false, remove: false, login: true },
  });
  assert.equal(showLogin(cursor, row({ auth_status: "", status_text: "ready", transport: "" })), true);
  assert.equal(showAdd(cursor), false);
  assert.equal(showRemove(cursor), false);

  const missing = surface({ manageable: false, verbs: { ...surface({}).verbs, login: true } });
  assert.equal(showLogin(missing, row({ auth_status: "notLoggedIn" })), false);
  assert.equal(showAdd(missing), false);
});
