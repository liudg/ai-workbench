import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTimeline,
  collapsedTurnSummary,
  formatElapsed,
  isSuppressedMessage,
  pickAnswer,
  runningTurnSummary,
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
  assert.equal(formatElapsed(turn.durationMs), "1m 28s");
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
  assert.equal(formatElapsed(turn.durationMs), "4s");
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
