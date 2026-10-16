import assert from "node:assert/strict";
import { test } from "node:test";

import type { McpServerRow, McpSurface } from "@/types";
import {
  MCP_PAGE,
  existingTitle,
  fieldVisible,
  registrationAria,
  rowStatusLine,
  showAdd,
  showLogin,
  showRemove,
  visibleFields,
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

test("settings copy follows the Codex zh-CN catalog and keeps protocol names", () => {
  assert.equal(MCP_PAGE.nav, "MCP 服务器");
  assert.equal(MCP_PAGE.subtitle, "连接外部工具和数据来源");
  assert.equal(MCP_PAGE.empty, "未连接 MCP 服务器");
  assert.equal(MCP_PAGE.add, "添加服务器");
  assert.equal(MCP_PAGE.titleNew, "连接至自定义 MCP");
  assert.equal(existingTitle("demo"), "更新 demo MCP");
  assert.equal(MCP_PAGE.settings, "设置");
  assert.equal(MCP_PAGE.authenticate, "进行身份验证");
  assert.equal(MCP_PAGE.starting, "启动中…");
  assert.equal(MCP_PAGE.headers, "Headers");
  assert.equal(registrationAria("auto"), "OAuth 客户端注册：自动");
  assert.equal(rowStatusLine(surface({}), row({})), "STDIO · 不支持 · 已启用");
  assert.equal(rowStatusLine(surface({}), row({ enabled: false, auth_status: "" })), "STDIO · 已禁用");
  assert.equal(
    rowStatusLine(surface({}), row({ transport: "", status_text: "√ Connected", auth_status: "", enabled: null })),
    "已连接",
  );
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
