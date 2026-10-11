import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTimeline,
  collapsedTurnSummary,
  formatElapsed,
  isSuppressedMessage,
  type TimelineNode,
} from "./timeline.ts";
import type { SessionEvent, SessionEventBody } from "../../../types.ts";

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
  assert.equal(nodes.some((node) => node.type === "work"), false);
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

test("leaves the live turn expanded", () => {
  const nodes = buildTimeline(
    [
      event("u1", 0, { kind: "user-message", text: "你好" }),
      event("c1", 1_000, {
        kind: "agent-message",
        text: "我会查看…",
        phase: "commentary",
      }),
      event("k1", 2_000, { kind: "tool-call", name: "command", summary: "rg" }),
      event("s1", 2_100, { kind: "status-changed", status: "running" }),
    ],
    "running",
  );
  assert.equal(nodes.some((node) => node.type === "turn"), false);
  assert.equal(nodes.some((node) => node.type === "work"), true);
  const commentary = nodes.find(
    (node) => node.type === "event" && node.event.id === "c1",
  );
  assert.ok(commentary && commentary.type === "event");
  assert.equal(commentary.showAgentLabel, false);
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
  const liveAnswer = nodes.find(
    (node) => node.type === "event" && node.event.id === "a2",
  );
  assert.ok(liveAnswer && liveAnswer.type === "event");
  assert.equal(liveAnswer.showAgentLabel, true);
});
