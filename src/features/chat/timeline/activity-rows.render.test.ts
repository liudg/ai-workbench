import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { createServer, type ViteDevServer } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Session, SessionEvent, SessionEventBody } from "../../../types/index.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

let server: ViteDevServer;
let chatHost: typeof import("../host.tsx").ChatHostProvider;

/** 聊天组件从 ChatHost 拿回答提问、Agent 资料和项目目录。测试给一份空的。 */
const testHost = {
  answerPrompt: async () => true,
  profiles: {},
  projectPath: "",
};

function renderInHost(element: ReactElement): string {
  return renderToStaticMarkup(createElement(chatHost, { host: testHost, children: element }));
}

before(async () => {
  server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  chatHost = (await server.ssrLoadModule("/src/features/chat/host.tsx")).ChatHostProvider;
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
  const html = renderInHost(
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

test("opening a settled row lists the calls in order, each folded until clicked", async () => {
  const fold = await server.ssrLoadModule("/src/features/chat/events/activity-fold.ts");
  const group = await server.ssrLoadModule("/src/features/chat/events/ActivityGroup.tsx");
  const pieces = fold.foldActivity(settledEvents).filter((piece: { type: string }) => piece.type === "tools");
  assert.equal(pieces.length, 2);
  const html = pieces
    .map((piece: { id: string }) =>
      renderInHost(
        createElement(group.ActivityGroup, {
          piece,
          session,
          open: piece.id === pieces[0].id,
          live: false,
          onToggle: () => {},
        }),
      ),
    )
    .join("");
  const openRow = html.slice(0, html.indexOf("已运行 1 条命令"));
  assert.equal(openRow.includes('data-expanded="true"'), true);
  assert.equal(openRow.includes("data-activity-steps"), true);
  assert.equal(openRow.includes('data-step-title="execute_code"'), true);
  assert.equal(openRow.includes('aria-expanded="false"'), true);
  assert.equal(openRow.includes("打开了宝石详情"), false);
  const closedRow = html.slice(html.indexOf("已运行 1 条命令"));
  assert.equal(closedRow.includes('data-expanded="false"'), true);
  assert.equal(closedRow.includes("data-activity-steps"), false);
  assert.equal(closedRow.includes("选中 1 行"), false);
});

const runningEvents: SessionEvent[] = [
  event("k0", { kind: "tool-call", name: "command", summary: "pnpm lint", status: "failed", exit_code: 2 }),
  event("k1", { kind: "tool-call", name: "command", summary: "pnpm test", status: "running" }),
];

test("a running step spins only while the turn is live, failures stay marked", async () => {
  const fold = await server.ssrLoadModule("/src/features/chat/events/activity-fold.ts");
  const group = await server.ssrLoadModule("/src/features/chat/events/ActivityGroup.tsx");
  const [piece] = fold.foldActivity(runningEvents);
  const render = (live: boolean) =>
    renderInHost(createElement(group.ActivityGroup, { piece, session, open: true, live, onToggle: () => {} }));
  const live = render(true);
  assert.equal(live.includes('data-activity-running="true"'), true);
  assert.equal(live.includes('data-step-state="running"'), true);
  assert.equal(live.includes("animate-spin"), true);
  assert.equal(live.includes("1 个失败"), true);
  assert.equal(live.includes("退出码 2"), true);
  const settled = render(false);
  assert.equal(settled.includes("data-activity-running"), false);
  assert.equal(settled.includes('data-step-state="running"'), false);
  assert.equal(settled.includes("animate-spin"), false);
  assert.equal(settled.includes('data-step-state="failed"'), true);
});

test("a live turn spins its running steps; the status row shows what it does and for how long", async () => {
  const turn = await server.ssrLoadModule("/src/features/chat/timeline/LiveTurn.tsx");
  for (const expanded of [true, false]) {
    const html = renderInHost(
      createElement(turn.LiveTurn, {
        events: runningEvents,
        session,
        resolvedAnswers: new Map(),
        expanded,
        onToggle: () => {},
      }),
    );
    assert.equal(html.includes("data-turn-running"), true);
    assert.equal(html.includes("animate-spin"), expanded);
    assert.equal(html.includes("data-live-status"), false);
  }
  const status = await server.ssrLoadModule("/src/features/chat/timeline/LiveStatus.tsx");
  const tools = await server.ssrLoadModule("/src/features/chat/events/tool-status.ts");
  const row = renderInHost(
    createElement(status.LiveStatus, {
      label: tools.liveActivityLabel(runningEvents),
      startedAt: Date.now() - 65_000,
    }),
  );
  assert.equal(row.includes('data-live-label="正在运行 pnpm test"'), true);
  assert.match(row, /data-live-elapsed[^>]*>1m 5s</);
});

test("the status row sits at the very bottom, after the live change card", () => {
  const view = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
  const card = view.indexOf("<ChangeCard changes={liveChanges}");
  const row = view.indexOf("<LiveStatus");
  const columnEnd = view.indexOf("</div>", row);
  assert.ok(card > 0 && row > card, "LiveStatus after the live ChangeCard");
  assert.ok(view.indexOf("turn-virtual-list") < card, "both after the virtual list");
  assert.ok(columnEnd > row);
});

test("tool output is boxed and keeps the tail of long output", async () => {
  const mod = await server.ssrLoadModule("/src/features/chat/events/ToolOutput.tsx");
  const output = Array.from({ length: 300 }, (_, index) => `line ${index}`).join("\n");
  const html = renderInHost(
    createElement(mod.ToolOutput, {
      command: "pnpm test",
      output,
      images: [],
      copyText: "pnpm test",
      running: false,
    }),
  );
  assert.equal(html.includes("max-h-64"), true);
  assert.equal(html.includes("data-own-scroll"), true);
  assert.equal(html.includes("已省略前 180 行"), true);
  assert.equal(html.includes("line 179\n"), false);
  assert.equal(html.includes("line 299"), true);
  const long = renderInHost(
    createElement(mod.ToolOutput, {
      command: "a\nb\nc\nd",
      output: "",
      images: [],
      copyText: "",
      running: false,
    }),
  );
  assert.equal(long.includes("line-clamp-3"), true);
  assert.equal(long.includes("展开命令"), true);
  assert.equal(long.includes("data-own-scroll"), false);
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
  return renderInHost(
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

test("generated images belong to the answer after all expanded activity, live and settled", async () => {
  const generated = event("generated", {
    kind: "tool-call", name: "image_generation", summary: "图片已生成",
    images: ["https://example.com/dog.png"],
  });
  const events = [
    event("note", { kind: "agent-message", text: "我会画一张骑行插画。", phase: "commentary" }),
    generated,
    event("check", { kind: "tool-call", name: "command", summary: "检查图片" }),
    event("answer", { kind: "agent-message", text: "画好了。", phase: "final-answer" }),
  ];
  for (const component of ["TurnProcess", "LiveTurn"]) {
    const mod = await server.ssrLoadModule(`/src/features/chat/timeline/${component}.tsx`);
    for (const expanded of [true, false]) {
      const html = renderInHost(createElement(mod[component], {
        events, answerId: "answer", durationMs: 1000, session,
        resolvedAnswers: new Map(), expanded, onToggle: () => {},
      }));
      assert.equal((html.match(/data-generated-images/g) ?? []).length, 1);
      assert.equal((html.match(/src="https:\/\/example.com\/dog.png"/g) ?? []).length, 1);
      assert.equal(html.includes("data-chat-image-open"), true);
      assert.equal(html.includes("我会画一张骑行插画。"), expanded);
      assert.equal(html.includes("已运行 1 条命令"), expanded);
      assertOrder(html, expanded
        ? ["data-turn-fold", "我会画一张骑行插画。", "已运行 1 条命令", "data-generated-images", "画好了。"]
        : ["data-turn-fold", "data-generated-images", "画好了。"]);
    }
    const imageOnly = renderInHost(createElement(mod[component], {
      events: events.slice(0, -1), answerId: null, durationMs: 1000, session,
      resolvedAnswers: new Map(), expanded: true, onToggle: () => {},
    }));
    assertOrder(imageOnly, ["我会画一张骑行插画。", "已运行 1 条命令", "data-generated-images"]);
  }
});

test("a settled turn keeps the status line as the first child", async () => {
  const mod = await server.ssrLoadModule("/src/features/chat/timeline/TurnProcess.tsx");
  const events: SessionEvent[] = [
    event("note", { kind: "system", text: "回合前提示" }),
    event("k1", { kind: "tool-call", name: "command", summary: "rg --files" }),
    event("answer", { kind: "agent-message", text: "目录里有 src。", phase: "final-answer" }),
  ];
  for (const expanded of [false, true]) {
    const html = renderInHost(
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
    assert.equal(html.startsWith('<div class="group min-w-0"><div class="event-in min-w-0 px-6 py-1"><button'), true);
    assertOrder(html, ['data-turn-summary="Codex CLI · 用时 0s"', "回合前提示", "目录里有 src"]);
    assert.equal(html.includes("已运行 1 条命令"), expanded);
  }
});

const liveEvents: SessionEvent[] = [
  event("note", { kind: "agent-message", text: "我会查看目录。", phase: "commentary" }),
  event("k1", { kind: "tool-call", name: "command", summary: "rg --files" }),
];

test("a running turn does not repeat the agent name or wedge the time before tools", async () => {
  const mod = await server.ssrLoadModule("/src/features/chat/timeline/LiveTurn.tsx");
  const events: SessionEvent[] = [
    event("a1", { kind: "agent-message", text: "先看一下工作目录。", phase: "final-answer" }),
    event("k1", { kind: "tool-call", name: "command", summary: "rg --files" }),
    event("a2", { kind: "agent-message", text: "坦克大战可以做成 H5。", phase: "partial-answer" }),
    event("t1", { kind: "thinking", text: "继续想方案。" }),
  ];
  const html = renderInHost(
    createElement(mod.LiveTurn, {
      events,
      session: { ...session, agent: "claude-code" },
      resolvedAnswers: new Map(),
      expanded: true,
      onToggle: () => {},
    }),
  );
  assert.equal(html.includes('data-turn-summary="Claude Code · 运行中"'), true);
  assert.equal(html.includes("data-agent-label"), false);
  assert.equal(html.includes("data-message-footer"), false);
  assert.equal(html.includes("星期"), false);
  assertOrder(html, [
    'data-turn-summary="Claude Code · 运行中"',
    "先看一下工作目录。",
    "已运行 1 条命令",
    "坦克大战可以做成 H5。",
  ]);
  const between = html.slice(html.indexOf("先看一下工作目录。"), html.indexOf("已运行 1 条命令"));
  assert.equal(between.includes("data-message-footer"), false);
  assert.equal(between.includes("Claude Code"), false);
});

test("a settled answer keeps the time and copy action after all content and file changes", async () => {
  const mod = await server.ssrLoadModule("/src/features/chat/timeline/TurnProcess.tsx");
  const events: SessionEvent[] = [
    event("a1", { kind: "agent-message", text: "先看一下工作目录。", phase: "final-answer" }),
    event("k1", { kind: "tool-call", name: "command", summary: "rg --files" }),
    event("a2", { kind: "agent-message", text: "目录里有 src。", phase: "final-answer" }),
    event("notice", { kind: "system", text: "答复后的提示" }),
    event("change", {
      kind: "file-change",
      turn_id: "turn-1",
      path: "src/app.ts",
      status: "M",
      added: 1,
      removed: 1,
      diff: "",
    }),
  ];
  const html = renderInHost(
    createElement(mod.TurnProcess, {
      events,
      answerId: "a2",
      durationMs: 3_339_000,
      session: { ...session, agent: "claude-code" },
      resolvedAnswers: new Map(),
      expanded: true,
      onToggle: () => {},
    }),
  );
  assert.equal(html.includes('data-turn-summary="Claude Code · 用时 55m 39s"'), true);
  assert.equal(html.includes("data-agent-label"), false);
  assertOrder(html, [
    'data-turn-summary="Claude Code · 用时 55m 39s"',
    "先看一下工作目录。",
    "已运行 1 条命令",
    "目录里有 src。",
    "答复后的提示",
    "data-change-card",
    "data-message-footer",
  ]);
  const between = html.slice(html.indexOf("先看一下工作目录。"), html.indexOf("已运行 1 条命令"));
  assert.equal(between.includes("data-message-footer"), false);
  const footer = html.slice(html.indexOf("data-message-footer"));
  assert.equal((html.match(/data-message-footer/g) ?? []).length, 1);
  assert.match(footer, /星期/);
  assert.match(footer, /复制/);
});

test("a running turn keeps the status line as the first child", async () => {
  const mod = await server.ssrLoadModule("/src/features/chat/timeline/LiveTurn.tsx");
  const expandedHtml = renderInHost(
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

  const collapsedHtml = renderInHost(
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

test("text written before a steer stays visible when the turn is folded", async () => {
  const events: SessionEvent[] = [
    event("first", { kind: "agent-message", text: "检讨：我在", phase: "commentary" }),
    event("steer", { kind: "user-message", text: "不够真诚" }),
    event("k1", { kind: "tool-call", name: "command", summary: "rg 醍醐" }),
    event("answer", { kind: "agent-message", text: "对不起。", phase: "final-answer" }),
  ];
  for (const component of ["TurnProcess", "LiveTurn"]) {
    const mod = await server.ssrLoadModule(`/src/features/chat/timeline/${component}.tsx`);
    for (const expanded of [false, true]) {
      const html = renderInHost(createElement(mod[component], {
        events, answerId: "answer", durationMs: 1000, session,
        resolvedAnswers: new Map(), expanded, onToggle: () => {},
      }));
      assert.equal((html.match(/data-turn-fold/g) ?? []).length, 1);
      assert.equal(html.includes("已运行 1 条命令"), expanded);
      // 进行中的一轮收起时，正在写的最后一段本来就不露出来。
      const stillWriting = component === "LiveTurn" && !expanded;
      assertOrder(html, stillWriting ? ["检讨：我在", "不够真诚"] : ["检讨：我在", "不够真诚", "对不起。"]);
      assert.equal(html.includes("对不起。"), !stillWriting);
    }
  }
});
