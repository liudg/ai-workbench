import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTimeline,
  chunkTimeline,
  collapsedTurnSummary,
  contentChars,
  formatElapsed,
  isCliConnectionLostAnswer,
  isProcess,
  isSuppressedMessage,
  pickAnswer,
  runningTurnSummary,
  timelineChunkKey,
  type TimelineNode,
} from "./timeline.ts";
import type { SessionEvent, SessionEventBody } from "../../../types/index.ts";

function event(id: string, ts: number, body: SessionEventBody): SessionEvent {
  return { id, session_id: "s", seq: Number(id.replace(/\D/g, "")) || 1, ts, ...body };
}

function turnNode(nodes: TimelineNode[]) {
  const turn = nodes.find((node) => node.type === "turn");
  assert.ok(turn && turn.type === "turn");
  return turn;
}

test("formats elapsed time as hours, minutes, and seconds", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(12_400), "12s");
  assert.equal(formatElapsed(88_000), "1m 28s");
  assert.equal(formatElapsed(120_000), "2m");
  assert.equal(formatElapsed(3_723_000), "1h 2m 3s");
});

test("collapsed turn summary is the agent label, a middot, then elapsed time", () => {
  assert.equal(collapsedTurnSummary("Agent CLI", 3_000), "Agent CLI · 用时 3s");
  assert.equal(collapsedTurnSummary("Other CLI", 88_000), "Other CLI · 用时 1m 28s");
  assert.equal(collapsedTurnSummary("Sample CLI", 0), "Sample CLI · 用时 0s");
});

test("running turn summary keeps the agent label and the in-progress phrase", () => {
  assert.equal(runningTurnSummary("Codex CLI"), "Codex CLI · 运行中");
  assert.equal(runningTurnSummary("Cursor Agent"), "Cursor Agent · 运行中");
});

test("connection-lost API error text is not the turn answer", () => {
  const lost =
    "API Error: Connection lost mid-response. The response above may be incomplete.";
  assert.equal(isCliConnectionLostAnswer(lost), true);
  assert.equal(isCliConnectionLostAnswer(`  ${lost}  `), true);
  assert.equal(isCliConnectionLostAnswer("先看目录"), false);
  const events = [
    event("u1", 0, { kind: "user-message", text: "做游戏" }),
    event("a1", 1_000, { kind: "agent-message", text: "先看目录。", phase: "final-answer" }),
    event("k1", 2_000, { kind: "tool-call", name: "command", summary: "rg --files" }),
    event("a2", 3_000, { kind: "agent-message", text: lost, phase: "final-answer" }),
    event("e1", 4_000, { kind: "error", message: "Claude Code 报错" }),
  ];
  assert.equal(isSuppressedMessage(events, 3), true);
  const nodes = buildTimeline(events, "completed");
  const turn = turnNode(nodes);
  assert.equal(turn.answerId, "a1");
  assert.equal(
    turn.events.some((item) => item.id === "a2" || (item.kind === "agent-message" && item.text === lost)),
    false,
  );
  const banner = turn.events.find((item) => item.kind === "error");
  assert.ok(banner && banner.kind === "error");
  assert.equal(banner.message, "Claude Code 连接中断");

  const earlier = buildTimeline(
    [
      event("u0", 0, { kind: "user-message", text: "别的" }),
      event("e0", 1, { kind: "error", message: "Claude Code 报错" }),
      event("u1", 2, { kind: "user-message", text: "做游戏" }),
      event("a2", 3, { kind: "agent-message", text: lost, phase: "final-answer" }),
    ],
    "completed",
  );
  const rendered = JSON.stringify(earlier);
  assert.equal(rendered.includes("Claude Code 报错"), true);
  assert.equal(rendered.includes(lost), false);
});

test("review duplicates use dedupe_of and plan duplicates use mode", () => {
  const events = [
    event("u1", 0, { kind: "user-message", text: "审查" }),
    event("p1", 1, { kind: "plan-text", text: "先改 app.ts", mode: "plan" }),
    event("a1", 2, { kind: "agent-message", text: "先改 app.ts", mode: "plan" }),
    event("a2", 3, { kind: "agent-message", text: "计划写好了", mode: "plan" }),
    event("r1", 4, {
      kind: "review-findings",
      summary: "通过",
      raw: "通过",
      findings: [],
    }),
    event("a3", 5, { kind: "agent-message", text: "通过", dedupe_of: "rev-1" }),
    event("a4", 6, { kind: "agent-message", text: "通过" }),
  ];
  assert.equal(isSuppressedMessage(events, 2), true);
  assert.equal(isSuppressedMessage(events, 3), false);
  assert.equal(isSuppressedMessage(events, 5), true);
  assert.equal(isSuppressedMessage(events, 6), false);
  const nodes = buildTimeline(events, "completed");
  const turn = turnNode(nodes);
  assert.equal(
    turn.events.some((item) => item.id === "a1" || item.id === "a3"),
    false,
  );
  assert.equal(
    turn.events.some((item) => item.id === "a2"),
    true,
  );
});

test("folds commentary, thinking, and tools into one settled turn", () => {
  const nodes = buildTimeline(
    [
      event("u1", 1_000, { kind: "user-message", text: "看一下" }),
      event("c1", 2_000, {
        kind: "agent-message",
        text: "我会查看目录。",
        phase: "commentary",
      }),
      event("t1", 3_000, { kind: "thinking", text: "先列文件" }),
      event("k1", 40_000, { kind: "tool-call", name: "command", summary: "rg --files" }),
      event("a1", 90_000, {
        kind: "agent-message",
        text: "目录里有 src。",
        phase: "final-answer",
      }),
      event("s1", 90_100, { kind: "status-changed", status: "completed" }),
    ],
    "completed",
  );
  const turn = turnNode(nodes);
  // 从用户发出算起，不是从第一条过程算起。
  assert.equal(formatElapsed(turn.durationMs), "1m 29s");
  assert.equal(turn.answerId, "a1");
  assert.deepEqual(
    turn.events.map((item) => item.id),
    ["c1", "t1", "k1", "a1"],
  );
  assert.equal(nodes.some((node) => node.type === "live"), false);
});

test("keeps an unknown-phase preamble folded and the last message as the answer", () => {
  const nodes = buildTimeline(
    [
      event("u1", 0, { kind: "user-message", text: "你好" }),
      event("p1", 1_000, { kind: "agent-message", text: "我会查看…" }),
      event("a1", 5_000, { kind: "agent-message", text: "结论" }),
    ],
    "completed",
  );
  const turn = turnNode(nodes);
  assert.equal(turn.answerId, "a1");
  assert.equal(formatElapsed(turn.durationMs), "5s");
});

test("a turn cut short by a steered message still counts its time", () => {
  const nodes = buildTimeline(
    [
      event("n1", 0, { kind: "turn-anchor", turn_id: "x" }),
      event("u1", 0, { kind: "user-message", text: "跑一下" }),
      event("k1", 6_000, { kind: "tool-call", name: "command", summary: "sleep 15" }),
      event("u2", 7_000, { kind: "user-message", text: "顺便加上 B" }),
      event("a1", 20_000, { kind: "agent-message", text: "A B", phase: "final-answer" }),
    ],
    "completed",
  );
  assert.equal(formatElapsed(turnNode(nodes).durationMs), "6s");
});

test("a turn the agent starts on its own gets its own fold without a user bubble", () => {
  const nodes = buildTimeline(
    [
      event("n1", 0, { kind: "turn-anchor", turn_id: "x" }),
      event("u1", 0, { kind: "user-message", text: "跑一下" }),
      event("k1", 1_000, { kind: "tool-call", name: "command", summary: "ls" }),
      event("a1", 2_000, { kind: "agent-message", text: "好了", phase: "final-answer" }),
      event("s1", 2_100, { kind: "status-changed", status: "completed" }),
      // 设了目标，Agent 自己开了一轮。
      event("g1", 60_000, { kind: "goal", objective: "有 add", status: "active" }),
      event("n2", 60_000, { kind: "turn-anchor", turn_id: "y" }),
      event("k2", 61_000, { kind: "tool-call", name: "read", summary: "calc.py" }),
      event("a2", 70_000, { kind: "agent-message", text: "条件已满足", phase: "final-answer" }),
    ],
    "completed",
  );
  const turns = nodes.filter((node) => node.type === "turn");
  assert.equal(turns.length, 2);
  assert.equal(turns[0].type === "turn" && turns[0].answerId, "a1");
  assert.equal(turns[1].type === "turn" && turns[1].answerId, "a2");
  assert.equal(turns[1].type === "turn" && formatElapsed(turns[1].durationMs), "10s");
  const bubbles = nodes.filter((node) => node.type === "event" && node.event.kind === "user-message");
  assert.equal(bubbles.length, 1);
});

test("an anchor right before or after a user message does not split the turn", () => {
  for (const order of [
    ["n", "u"],
    ["u", "n"],
  ]) {
    const head = order.map((key) =>
      key === "n"
        ? event("n1", 0, { kind: "turn-anchor", turn_id: "x" })
        : event("u1", 0, { kind: "user-message", text: "看看" }),
    );
    const nodes = buildTimeline(
      [
        event("a0", 0, { kind: "agent-message", text: "上一轮", phase: "final-answer" }),
        ...head,
        event("k1", 1_000, { kind: "tool-call", name: "command", summary: "ls" }),
        event("a1", 2_000, { kind: "agent-message", text: "好了", phase: "final-answer" }),
      ],
      "completed",
    );
    assert.equal(nodes.filter((node) => node.type === "turn").length, 1, order.join());
    assert.equal(turnNode(nodes).answerId, "a1");
  }
});

test("puts a running turn in the transcript with each tool call kept", () => {
  const nodes = buildTimeline(
    [
      event("u1", 0, { kind: "user-message", text: "你好" }),
      event("c1", 1_000, {
        kind: "agent-message",
        text: "我会查看…",
        phase: "commentary",
      }),
      event("k1", 2_000, { kind: "tool-call", name: "command", summary: "rg --files" }),
      event("k2", 3_000, {
        kind: "tool-call",
        name: "command",
        summary: "npm uninstall gemini-cli",
      }),
      event("s1", 3_100, { kind: "status-changed", status: "running" }),
    ],
    "running",
  );
  assert.equal(nodes.some((node) => node.type === "turn"), false);
  const live = nodes.find((node) => node.type === "live");
  assert.ok(live && live.type === "live");
  assert.equal(live.id, "live-u1");
  assert.deepEqual(
    live.events.map((item) => item.id),
    ["c1", "k1", "k2"],
  );
  assert.equal(
    nodes.some((node) => node.type === "event" && node.event.id === "c1"),
    false,
  );
});

test("leaves a needs-input turn expanded as separate events", () => {
  const nodes = buildTimeline(
    [
      event("u1", 0, { kind: "user-message", text: "你好" }),
      event("k1", 1_000, { kind: "tool-call", name: "command", summary: "rg" }),
      event("p1", 2_000, {
        kind: "prompt",
        prompt_id: "ask",
        prompt_kind: "approval",
        question: "允许？",
        options: [],
        questions: [],
      }),
      event("s1", 2_100, { kind: "status-changed", status: "needs-input" }),
    ],
    "needs-input",
  );
  assert.equal(nodes.some((node) => node.type === "live"), false);
  assert.equal(
    nodes.some((node) => node.type === "event" && node.event.kind === "tool-call"),
    true,
  );
  assert.equal(
    nodes.some((node) => node.type === "event" && node.event.kind === "prompt"),
    true,
  );
});

test("labels only the final answer once an earlier turn has settled", () => {
  const nodes = buildTimeline(
    [
      event("u1", 0, { kind: "user-message", text: "第一问" }),
      event("c1", 1_000, {
        kind: "agent-message",
        text: "我会查看…",
        phase: "commentary",
      }),
      event("a1", 8_000, {
        kind: "agent-message",
        text: "第一答",
        phase: "final-answer",
      }),
      event("u2", 9_000, { kind: "user-message", text: "第二问" }),
      event("a2", 10_000, {
        kind: "agent-message",
        text: "第二答",
        phase: "final-answer",
      }),
    ],
    "running",
  );
  const settled = nodes.filter((node) => node.type === "turn");
  assert.equal(settled.length, 1);
  const live = nodes.find((node) => node.type === "live");
  assert.ok(live && live.type === "live");
  assert.equal(pickAnswer(live.events, false)?.id, "a2");
  assert.equal(
    live.events.some((item) => item.id === "a1"),
    false,
  );
});

test("a pinned plan choice is not folded into the finished turn", () => {
  const prompt = event("p1", 30_000, {
    kind: "prompt",
    prompt_id: "implement-plan-1",
    prompt_kind: "choice",
    question: "实施此计划？",
    options: [
      { id: "implement", label: "是，实施此计划", slot: "primary" },
      { id: "stay", label: "否，留在计划模式", slot: "deny" },
    ],
    questions: [],
  });
  assert.equal(isProcess(prompt, "a1"), false);
  const nodes = buildTimeline(
    [
      event("u1", 0, { kind: "user-message", text: "做一个贪吃蛇" }),
      event("k1", 1_000, { kind: "tool-call", name: "command", summary: "ls" }),
      event("a1", 29_000, {
        kind: "agent-message",
        text: "计划正文",
        phase: "final-answer",
      }),
      prompt,
      event("s1", 29_100, { kind: "status-changed", status: "completed" }),
    ],
    "completed",
  );
  const turn = turnNode(nodes);
  assert.equal(turn.answerId, "a1");
  assert.equal(
    turn.events.some((item) => item.kind === "prompt"),
    true,
  );
});

test("session usage stays out of the timeline", () => {
  const nodes = buildTimeline(
    [
      event("usage", 1, {
        kind: "session-usage",
        scope: "snapshot",
        input_tokens: 8000,
        output_tokens: 2300,
      }),
      event("u", 2, { kind: "user-message", text: "问" }),
    ],
    "completed",
  );
  const rendered = JSON.stringify(nodes);
  assert.equal(rendered.includes("session-usage"), false);
  assert.equal(rendered.includes("8000"), false);
});

test("timeline chunks keep preamble, the user message, and the turn apart", () => {
  const nodes = buildTimeline(
    [
      event("sys", 0, { kind: "system", text: "准备" }),
      event("u1", 1, { kind: "user-message", text: "你好" }),
      event("c1", 2, { kind: "agent-message", text: "先看一下", phase: "commentary" }),
      event("k1", 3, { kind: "tool-call", name: "command", summary: "ls" }),
      event("a1", 4, { kind: "agent-message", text: "在", phase: "final-answer" }),
    ],
    "completed",
  );
  const chunks = chunkTimeline(nodes);
  assert.deepEqual(
    chunks.map((chunk) => timelineChunkKey(chunk)),
    ["events-sys", "u1", "c1"],
  );
  assert.equal(chunks[0]?.type, "events");
  assert.equal(chunks[1]?.type, "block");
  assert.equal(chunks[2]?.type, "block");
  assert.equal(new Set(chunks.map((chunk) => timelineChunkKey(chunk))).size, chunks.length);
});

test("review findings omitted from the payload do not throw", () => {
  const review = event("r1", 1, {
    kind: "review-findings",
    summary: "通过",
    raw: "",
    findings: [{ title: "标题", location: "a.ts", body: "正文" }],
  });
  const missing = { ...review, findings: undefined } as unknown as SessionEvent;
  assert.equal(contentChars([missing]), "通过".length);
  assert.equal(contentChars([review]), "通过".length + "正文".length);
});

function messageTexts(nodes: TimelineNode[], kind: "user-message" | "agent-message"): string[] {
  const texts: string[] = [];
  for (const node of nodes) {
    if (node.type === "event" && node.event.kind === kind) texts.push(node.event.text);
    if (node.type === "turn") {
      for (const event of node.events) {
        if (event.kind === kind) texts.push(event.text);
      }
    }
  }
  return texts;
}

// 历史回放的重复正文在 Codex bodies_from_turns 去掉。
// 时间线只按已经写进日志的事件画：id 不同就各画一个气泡。
// 实时第二次发送同文案不在这里按正文丢掉。
test("distinct message ids are both drawn", () => {
  const write = "Write the numbers 1 to 3000, one per line, no tools.";
  const events = [
    event("u1", 1, { kind: "user-message", text: "reply ok" }),
    event("a1", 2, { kind: "agent-message", text: "ok" }),
    event("u2", 3, { kind: "user-message", text: write }),
    event("u3", 4, { kind: "user-message", text: "reply ok" }),
    event("a2", 5, { kind: "agent-message", text: "ok" }),
    event("u4", 6, { kind: "user-message", text: write }),
  ];
  const nodes = buildTimeline(events, "completed");
  assert.deepEqual(messageTexts(nodes, "user-message"), ["reply ok", write, "reply ok", write]);
  assert.deepEqual(messageTexts(nodes, "agent-message"), ["ok", "ok"]);
});
