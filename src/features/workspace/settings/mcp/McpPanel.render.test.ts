import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

import type { McpServerRow, McpSurface } from "@/types";
import { claudeRows, codexRows, cursorRows, loginRow, previewSurfaces } from "./fixtures.ts";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));

let server: ViteDevServer;
let Panel: typeof import("./McpPanel.tsx").McpPanel;

before(async () => {
  server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  const mod = await server.ssrLoadModule("/src/features/workspace/settings/mcp/McpPanel.tsx");
  Panel = mod.McpPanel;
});

after(async () => {
  await server?.close();
});

function row(patch: Partial<McpServerRow>): McpServerRow {
  return {
    name: "demo",
    transport: "stdio",
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

const toggleSurface: McpSurface = {
  ...previewSurfaces[2],
  verbs: { ...previewSurfaces[2].verbs, enable: true, disable: true },
};

function render(
  props: Partial<ComponentProps<typeof Panel>> & Pick<ComponentProps<typeof Panel>, "surfaces" | "rows">,
) {
  return renderToStaticMarkup(
    createElement(Panel, {
      selected: "codex-cli",
      listError: null,
      rowBusy: null,
      formBusy: false,
      feedback: null,
      highlight: null,
      tools: {},
      onSelect: () => {},
      onAdd: () => true,
      onRemove: () => {},
      onLogin: () => {},
      onLogout: () => {},
      onSetEnabled: () => {},
      onListTools: () => {},
      ...props,
    }),
  );
}

test("list rows show transport, one status, and a single toggle", () => {
  const html = render({
    surfaces: previewSurfaces,
    rows: codexRows,
    highlight: { name: "wb-mcp-probe", token: 1 },
  });
  assert.equal(html.includes('data-mcp-transport-tag="STDIO"'), true);
  assert.equal(html.includes('data-mcp-transport-tag="HTTP"'), true);
  assert.equal(html.includes('data-mcp-status="connected"'), true);
  assert.equal(html.includes("已连接"), true);
  assert.equal(html.includes('data-mcp-highlight="wb-mcp-probe"'), true);
  assert.equal(html.includes("data-mcp-toggle"), false);
  assert.equal(html.includes("data-mcp-enable"), false);
  assert.equal(html.includes("data-mcp-disable"), false);
  assert.equal(html.includes("未观察"), false);
  assert.equal(html.includes("如需切换"), false);
  assert.equal(html.includes("更新 wb-mcp-probe MCP"), false);
  assert.equal(html.includes(SCOPES_PLACEHOLDER), false);

  const claude = render({
    surfaces: previewSurfaces,
    selected: "claude-code",
    rows: claudeRows,
  });
  assert.equal(claude.includes('data-mcp-status="failed"'), true);
  assert.equal(claude.includes('data-mcp-status="connected"'), true);
  assert.equal(claude.includes('data-mcp-transport-tag="HTTP"'), true);
  assert.equal(claude.includes('data-mcp-transport-tag="STDIO"'), true);

  const toggles = render({
    surfaces: [toggleSurface],
    selected: "cursor-agent",
    rows: [row({ name: "on", enabled: true }), row({ name: "off", enabled: false, transport: "" })],
    rowBusy: "on",
  });
  const on = toggles.match(/<button[^>]*data-mcp-toggle="on"[^>]*>/)?.[0] ?? "";
  const off = toggles.match(/<button[^>]*data-mcp-toggle="off"[^>]*>/)?.[0] ?? "";
  assert.equal(on.includes("disabled="), true);
  assert.equal(off.includes("disabled="), false);
  assert.equal(toggles.includes("处理中…"), true);
  assert.equal(toggles.includes('data-mcp-status="disabled"'), true);
  assert.equal(toggles.includes("data-mcp-enable"), false);
  assert.equal(toggles.includes("data-mcp-disable"), false);

  const cursor = render({
    surfaces: previewSurfaces,
    selected: "cursor-agent",
    rows: cursorRows,
  });
  assert.equal(cursor.includes("data-mcp-toggle"), false);
  assert.equal(cursor.includes("已连接"), true);
});

test("notices split success toast from collapsed failure, and missing CLIs stay grey", () => {
  const success = render({
    surfaces: previewSurfaces,
    rows: codexRows,
    feedback: { tone: "success", text: "已保存" },
  });
  assert.equal(success.includes('data-mcp-toast=""'), true);
  assert.equal(success.includes('role="status"'), true);
  assert.equal(success.includes("已保存"), true);
  assert.equal(success.includes("无法卸载"), false);
  assert.equal(success.includes("卸载失败"), false);

  const form = render({
    surfaces: previewSurfaces,
    rows: [],
    initialMode: "new",
    feedback: { tone: "success", text: "已保存" },
  });
  assert.equal(form.includes('data-mcp-form="new"'), true);
  assert.equal(form.includes('data-mcp-toast=""'), true);
  assert.equal(form.includes('role="alert"'), false);

  const failure = render({
    surfaces: previewSurfaces,
    rows: codexRows,
    feedback: { tone: "failure", title: "无法禁用", detail: "disable: permission denied" },
  });
  assert.equal(failure.includes('data-mcp-error=""'), true);
  assert.equal(failure.includes('role="alert"'), true);
  assert.equal(failure.includes("无法禁用"), true);
  assert.equal(failure.includes("查看详情"), true);
  assert.equal(failure.includes("disable: permission denied"), true);
  assert.equal(failure.includes("<details"), true);
  assert.equal(failure.includes("<details open"), false);
  assert.equal(failure.includes("无法启用"), false);

  const missing = render({
    surfaces: previewSurfaces.map((item) =>
      item.kind === "kimi-code"
        ? { ...item, unavailable_reason: "本机没有该 CLI，MCP 动词未验证。" }
        : item,
    ),
    selected: "kimi-code",
    rows: [],
  });
  assert.equal(missing.includes('data-mcp-installed="false"'), true);
  assert.equal(missing.includes("未安装"), true);
  assert.equal(missing.includes("MCP 动词未验证"), false);
  assert.equal(missing.includes("data-mcp-unavailable"), false);
  assert.equal(missing.includes("未观察"), false);

  const voice = render({
    surfaces: previewSurfaces,
    selected: "kimi-code",
    rows: [],
  });
  assert.equal(voice.includes("未检测到 Kimi Code，安装后可在此管理 MCP。"), true);
  assert.equal(voice.includes('data-mcp-installed="false"'), true);
});

test("detail is titled with the server name, masks secrets, and lists tools", () => {
  const secret = row({
    name: "secret-mcp",
    transport: "streamable_http",
    url: "https://example.invalid/mcp",
    env: [{ key: "TOKEN", value: "super-secret-value" }],
    headers: [{ key: "Authorization", value: "Bearer secret-token" }],
    enabled: true,
    auth_status: "bearer_token",
  });
  const html = render({
    surfaces: previewSurfaces,
    rows: [secret, loginRow],
    initialOpen: "secret-mcp",
    tools: { "secret-mcp": [{ name: "echo", description: "回声" }] },
  });
  assert.equal(html.includes('data-mcp-detail-title=""'), true);
  assert.equal(html.includes("secret-mcp"), true);
  assert.equal(html.includes("更新 secret-mcp MCP"), false);
  assert.equal(html.includes("如需切换 MCP 服务器类型"), false);
  assert.equal(html.includes("super-secret-value"), false);
  assert.equal(html.includes("Bearer secret-token"), false);
  assert.equal(html.includes('data-mcp-secret-value="masked"'), true);
  assert.equal(html.includes("显示"), true);
  assert.equal(html.includes("TOKEN"), true);
  assert.equal(html.includes("Authorization"), true);
  assert.equal(html.includes(">HTTP</dd>"), true);
  assert.equal(html.includes("卸载此 MCP 服务器"), false);
  assert.equal(html.includes("卸载"), true);

  const tools = render({
    surfaces: [toggleSurface],
    selected: "cursor-agent",
    rows: [row({ name: "demo-ready", status_text: "ready", enabled: null })],
    initialOpen: "demo-ready",
    tools: {
      "demo-ready": [
        { name: "echo", description: "回声" },
        { name: "ping", description: "" },
      ],
    },
  });
  assert.equal(tools.includes('data-mcp-tool="echo"'), true);
  assert.equal(tools.includes("回声"), true);
  assert.equal(tools.includes('data-mcp-tool="ping"'), true);
  assert.equal(tools.includes("<pre"), false);
  assert.equal(tools.includes("身份验证"), true);
  assert.equal(tools.includes("查看工具"), true);
  assert.equal(tools.includes(SCOPES_PLACEHOLDER), false);

  const loggedOut = render({
    surfaces: previewSurfaces,
    rows: [loginRow, ...claudeRows],
    initialOpen: "wb-mcp-oauth",
  });
  assert.equal(loggedOut.includes('data-mcp-status="loggedOut"'), true);
  assert.equal(loggedOut.includes("未登录"), true);
  assert.equal(loggedOut.includes("身份验证"), true);
  assert.equal(loggedOut.includes(SCOPES_PLACEHOLDER), false);
  assert.equal(loggedOut.includes("取消认证"), true);
});

const SCOPES_PLACEHOLDER = "要请求的 OAuth scope，用逗号分隔";
