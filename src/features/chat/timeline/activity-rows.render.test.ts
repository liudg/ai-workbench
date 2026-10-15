import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

import type { Session, SessionEvent, SessionEventBody } from "../../../types/index.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

let server: ViteDevServer;

before(async () => {
  server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
});

after(async () => {
  await server?.close();
});

function event(id: string, body: SessionEventBody): SessionEvent {
  return { id, session_id: "s", seq: 1, ts: 1, ...body };
}

const session: Session = {
  id: "s",
  project_id: "p",
  agent: "codex-cli",
  native_id: "s",
  title: "t",
  status: "completed",
  created_at: 1,
  updated_at: 1,
};

const settledEvents: SessionEvent[] = [
  event("note", { kind: "agent-message", text: "旁白不该出现在收起的回合里。", phase: "commentary" }),
  event("t1", { kind: "thinking", text: "先看背包里的宝石。" }),
  event("m1", {
    kind: "tool-call",
    name: "execute_code",
    summary: "MCP unityMCP execute_code",
    detail: "结果\n打开了宝石详情",
  }),
  event("t2", { kind: "thinking", text: "再跑一条命令。" }),
  event("k1", {
    kind: "tool-call",
    name: "command",
    summary: "检查了表格选中",
    detail: "选中 1 行",
  }),
];

test("a settled stream collapses tool rows and hides thinking", async () => {
  const mod = await server.ssrLoadModule("/src/features/chat/timeline/ActivityStream.tsx");
  const html = renderToStaticMarkup(
    createElement(mod.ActivityStream, {
      events: settledEvents,
      session,
      resolvedAnswers: new Map(),
      showAgentLabel: () => false,
      toolsOnly: true,
      settled: true,
      thinking: true,
    }),
  );
  assert.equal(html.includes('data-activity-settled="true"'), true);
  assert.equal(html.includes("先看背包里的宝石"), false);
  assert.equal(html.includes("再跑一条命令"), false);
  assert.equal(html.includes("正在思考"), false);
  assert.equal(html.includes("旁白不该出现在收起的回合里"), false);
  assert.equal(html.includes("已使用 unityMCP 集成运行了命令"), true);
  assert.equal(html.includes("已运行 1 条命令"), true);
  assert.equal(html.includes('data-expanded="false"'), true);
  assert.equal(html.includes('data-expanded="true"'), false);
  assert.equal(html.includes("data-activity-steps"), false);
  assert.equal(html.includes("打开了宝石详情"), false);
  assert.equal(html.includes("选中 1 行"), false);
  const unity = html.indexOf("已使用 unityMCP 集成运行了命令");
  const command = html.indexOf("已运行 1 条命令");
  assert.equal(unity < command, true);
});

test("opening a settled row shows the calls in order with their output", async () => {
  const fold = await server.ssrLoadModule("/src/features/chat/events/activity-fold.ts");
  const group = await server.ssrLoadModule("/src/features/chat/events/ActivityGroup.tsx");
  const pieces = fold.foldActivity(settledEvents).filter((piece: { type: string }) => piece.type === "tools");
  assert.equal(pieces.length, 2);
  const html = pieces
    .map((piece: { id: string }) =>
      renderToStaticMarkup(
        createElement(group.ActivityGroup, {
          piece,
          session,
          open: piece.id === pieces[0].id,
          onToggle: () => {},
        }),
      ),
    )
    .join("");
  const openRow = html.slice(0, html.indexOf("已运行 1 条命令"));
  assert.equal(openRow.includes('data-expanded="true"'), true);
  assert.equal(openRow.includes("data-activity-steps"), true);
  assert.equal(openRow.includes("execute_code"), true);
  assert.equal(openRow.includes("MCP unityMCP execute_code"), true);
  assert.equal(openRow.includes("打开了宝石详情"), true);
  const closedRow = html.slice(html.indexOf("已运行 1 条命令"));
  assert.equal(closedRow.includes('data-expanded="false"'), true);
  assert.equal(closedRow.includes("data-activity-steps"), false);
  assert.equal(closedRow.includes("选中 1 行"), false);
});

test("a running stream still shows the thinking line and keeps tool rows collapsed", async () => {
  const mod = await server.ssrLoadModule("/src/features/chat/timeline/ActivityStream.tsx");
  const html = renderToStaticMarkup(
    createElement(mod.ActivityStream, {
      events: settledEvents,
      session,
      resolvedAnswers: new Map(),
      showAgentLabel: () => false,
      thinking: true,
      settled: false,
    }),
  );
  assert.equal(html.includes('data-activity-settled="false"'), true);
  assert.equal(html.includes("正在思考"), true);
  assert.equal(html.includes("先看背包里的宝石"), false);
  assert.equal(html.includes('data-expanded="false"'), true);
  assert.equal(html.includes("data-activity-steps"), false);
  assert.equal(html.includes("旁白不该出现在收起的回合里"), true);
});
