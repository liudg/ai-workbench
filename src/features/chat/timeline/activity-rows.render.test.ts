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
  event("note", { kind: "agent-message", text: "旁白按顺序留下。", phase: "commentary" }),
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

test("a settled stream collapses tool rows and hides finished thinking", async () => {
  const mod = await server.ssrLoadModule("/src/features/chat/timeline/ActivityStream.tsx");
  const html = renderToStaticMarkup(
    createElement(mod.ActivityStream, {
      events: settledEvents,
      session,
      resolvedAnswers: new Map(),
      showAgentLabel: () => false,
      settled: true,
    }),
  );
  assert.equal(html.includes('data-activity-settled="true"'), true);
  assert.equal(html.includes("先看背包里的宝石"), false);
  assert.equal(html.includes("再跑一条命令"), false);
  assert.equal(html.includes("正在思考"), false);
  assert.equal(html.includes("旁白按顺序留下"), true);
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
  assert.equal(html.includes("旁白按顺序留下"), true);
});

function commands(prefix: string, count: number): SessionEvent[] {
  return Array.from({ length: count }, (_, index) =>
    event(`${prefix}${index}`, {
      kind: "tool-call",
      name: "command",
      summary: `步骤 ${prefix}${index}`,
      detail: `输出 ${prefix}${index}`,
    }),
  );
}

const nestedTurn: SessionEvent[] = [
  event("note", { kind: "agent-message", text: "先看表格。", phase: "commentary" }),
  event("think-a", { kind: "thinking", text: "先看背包里的宝石。" }),
  ...commands("a", 3),
  event("think-b", { kind: "thinking", text: "再跑六条。" }),
  ...commands("b", 6),
  event("think-c", { kind: "thinking", text: "再跑八条。" }),
  ...commands("c", 8),
  event("img", { kind: "tool-call", name: "image", summary: "gem.png", images: ["gem.png"] }),
  event("mcp", {
    kind: "tool-call",
    name: "execute_code",
    summary: "MCP unityMCP execute_code",
    detail: "打开了宝石详情",
  }),
  event("answer", { kind: "agent-message", text: "目录里有 src。", phase: "final-answer" }),
];

async function renderProcess(expanded: boolean, agent: Session["agent"]) {
  const mod = await server.ssrLoadModule("/src/features/chat/timeline/TurnProcess.tsx");
  return renderToStaticMarkup(
    createElement(mod.TurnProcess, {
      events: nestedTurn,
      answerId: "answer",
      durationMs: 0,
      session: { ...session, agent },
      resolvedAnswers: new Map(),
      expanded,
      onToggle: () => {},
    }),
  );
}

test("a collapsed process keeps only the header and hides child activity", async () => {
  for (const [agent, header] of [
    ["codex-cli", "Codex CLI · 用时 0s"],
    ["claude-code", "Claude Code · 用时 0s"],
  ] as const) {
    const html = await renderProcess(false, agent);
    assert.equal(html.includes('data-turn-fold'), true);
    assert.equal(html.includes(`data-turn-summary="${header}"`), true);
    assert.equal(html.includes('data-expanded="false"'), true);
    assert.equal(html.includes('data-expanded="true"'), false);
    assert.equal(html.includes("data-activity-stream"), false);
    assert.equal(html.includes("data-activity-group"), false);
    assert.equal(html.includes("data-viewed-images"), false);
    assert.equal(html.includes("已运行"), false);
    assert.equal(html.includes("已使用"), false);
    assert.equal(html.includes("已查看"), false);
    assert.equal(html.includes("正在思考"), false);
    assert.equal(html.includes("先看表格"), false);
    assert.equal(html.includes("先看背包里的宝石"), false);
    assert.equal(html.includes("再跑六条"), false);
    assert.equal(html.includes("再跑八条"), false);
    assert.equal(html.includes("打开了宝石详情"), false);
    assert.equal(html.includes("步骤 "), false);
    assert.equal(html.includes("输出 "), false);
    assert.equal(html.includes("gem.png"), false);
    assert.equal(html.includes("目录里有 src"), true);
    assert.equal(html.indexOf(header) < html.indexOf("目录里有 src"), true);
  }
});

test("an expanded process shows collapsed tool, command, MCP, and image rows", async () => {
  const html = await renderProcess(true, "codex-cli");
  assert.equal(html.includes('data-turn-summary="Codex CLI · 用时 0s"'), true);
  assert.equal(html.includes('data-activity-settled="true"'), true);
  assert.equal(html.includes("先看表格。"), true);
  assert.equal(html.includes("已运行 3 条命令"), true);
  assert.equal(html.includes("已运行 6 条命令"), true);
  assert.equal(html.includes("已运行 8 条命令"), true);
  assert.equal(html.includes("已查看 1 张图像"), true);
  assert.equal(html.includes("已使用 unityMCP 集成运行了命令"), true);
  assert.equal(html.includes("先看背包里的宝石"), false);
  assert.equal(html.includes("再跑六条"), false);
  assert.equal(html.includes("再跑八条"), false);
  assert.equal(html.includes("正在思考"), false);
  assert.equal(html.includes("打开了宝石详情"), false);
  assert.equal(html.includes("步骤 "), false);
  assert.equal(html.includes("输出 "), false);
  assert.equal(html.includes("gem.png"), false);
  assert.equal(html.includes("data-activity-steps"), false);
  assert.equal(html.includes("data-viewed-thumbs"), false);
  assert.equal(html.includes("目录里有 src"), true);
  assert.equal((html.match(/data-expanded="true"/g) ?? []).length, 1);
  assert.equal((html.match(/data-activity-group/g) ?? []).length, 4);
  assert.equal((html.match(/data-viewed-images/g) ?? []).length, 1);
  const note = html.indexOf("先看表格");
  const three = html.indexOf("已运行 3 条命令");
  const six = html.indexOf("已运行 6 条命令");
  const eight = html.indexOf("已运行 8 条命令");
  const images = html.indexOf("已查看 1 张图像");
  const mcp = html.indexOf("已使用 unityMCP 集成运行了命令");
  const answer = html.indexOf("目录里有 src");
  assert.equal(note < three && three < six && six < eight && eight < images && images < mcp && mcp < answer, true);
});

function assertOrder(html: string, markers: string[]) {
  let cursor = -1;
  for (const marker of markers) {
    const at = html.indexOf(marker);
    assert.ok(at > cursor, `${marker} after previous marker`);
    cursor = at;
  }
}

test("a settled turn keeps the status line as the first child", async () => {
  const mod = await server.ssrLoadModule("/src/features/chat/timeline/TurnProcess.tsx");
  const events: SessionEvent[] = [
    event("note", { kind: "system", text: "回合前提示" }),
    event("k1", { kind: "tool-call", name: "command", summary: "rg --files" }),
    event("answer", { kind: "agent-message", text: "目录里有 src。", phase: "final-answer" }),
  ];
  for (const expanded of [false, true]) {
    const html = renderToStaticMarkup(
      createElement(mod.TurnProcess, {
        events,
        answerId: "answer",
        durationMs: 0,
        session,
        resolvedAnswers: new Map(),
        expanded,
        onToggle: () => {},
      }),
    );
    assert.equal(html.startsWith('<div class="min-w-0"><div class="event-in min-w-0 px-6 py-1"><button'), true);
    assertOrder(html, ['data-turn-summary="Codex CLI · 用时 0s"', "回合前提示", "目录里有 src"]);
    assert.equal(html.includes("已运行 1 条命令"), expanded);
  }
});

const liveEvents: SessionEvent[] = [
  event("note", { kind: "agent-message", text: "我会查看目录。", phase: "commentary" }),
  event("k1", { kind: "tool-call", name: "command", summary: "rg --files" }),
];

test("a running turn keeps the status line as the first child", async () => {
  const mod = await server.ssrLoadModule("/src/features/chat/timeline/LiveTurn.tsx");
  const expandedHtml = renderToStaticMarkup(
    createElement(mod.LiveTurn, {
      events: liveEvents,
      session,
      resolvedAnswers: new Map(),
      expanded: true,
      onToggle: () => {},
    }),
  );
  assert.equal(
    expandedHtml.startsWith('<div class="min-w-0" data-live-turn="true"><div class="event-in min-w-0 px-6 py-1"><button'),
    true,
  );
  assertOrder(expandedHtml, ['data-turn-summary="Codex CLI · 运行中"', "我会查看目录。", "已运行 1 条命令"]);
  assert.equal(expandedHtml.includes("data-turn-running"), true);

  const collapsedHtml = renderToStaticMarkup(
    createElement(mod.LiveTurn, {
      events: liveEvents,
      session,
      resolvedAnswers: new Map(),
      expanded: false,
      onToggle: () => {},
    }),
  );
  assert.equal(
    collapsedHtml.startsWith('<div class="min-w-0" data-live-turn="true"><div class="event-in min-w-0 px-6 py-1"><button'),
    true,
  );
  assert.equal(collapsedHtml.includes('data-turn-summary="Codex CLI · 运行中"'), true);
  assert.equal(collapsedHtml.includes("我会查看目录。"), false);
  assert.equal(collapsedHtml.includes("已运行 1 条命令"), false);
  assert.equal(collapsedHtml.includes("data-activity-stream"), false);
});
