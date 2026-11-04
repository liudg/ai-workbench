import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent, SessionEventBody } from "../../../types/index.ts";
import { buildTimeline } from "../timeline/timeline.ts";
import { foldActivity } from "./activity-fold.ts";
import {
  subagentElapsed,
  subagentGroupSummary,
  subagentMeta,
  subagentResultShown,
  subagentSteps,
  subagentTitle,
  subagentUsage,
  type SubagentEvent,
} from "./subagent-display.ts";

function event(id: string, ts: number, body: SessionEventBody): SessionEvent {
  return { id, session_id: "s", seq: ts, ts, ...body } as SessionEvent;
}

function card(id: string, patch: Partial<SubagentEvent> = {}): SubagentEvent {
  return {
    id: `e-${id}`,
    session_id: "s",
    seq: 1,
    ts: 1,
    kind: "subagent",
    subagent_id: id,
    title: "Run echo PING",
    status: "running",
    ...patch,
  };
}

test("steps are grouped per subagent and keep the outer id and time", () => {
  const steps = subagentSteps([
    event("a1", 1, { kind: "subagent-step", subagent_id: "a", step: { kind: "agent-message", text: "PING" } }),
    event("m", 2, { kind: "agent-message", text: "主线" }),
    event("b1", 3, { kind: "subagent-step", subagent_id: "b", step: { kind: "tool-call", name: "command", summary: "ls" } }),
    event("a2", 4, { kind: "subagent-step", subagent_id: "a", step: { kind: "thinking", text: "想" } }),
  ]);
  assert.deepEqual(
    steps.get("a")?.map((step) => [step.id, step.kind, step.ts]),
    [
      ["a1", "agent-message", 1],
      ["a2", "thinking", 4],
    ],
  );
  assert.equal(steps.get("b")?.[0].kind, "tool-call");
});

test("title, meta, usage and elapsed come from the card fields", () => {
  assert.equal(subagentTitle(card("a", { title: "", agent_type: "general-purpose" })), "general-purpose");
  assert.equal(subagentTitle(card("a", { title: " " })), "子 Agent");
  assert.equal(subagentMeta(card("a", { agent_type: "explorer", model: "gpt-6-astra", effort: "low" })), "explorer · gpt-6-astra · low");
  assert.equal(subagentMeta(card("a", { title: "", agent_type: "explorer", model: "haiku" })), "haiku");
  assert.equal(subagentUsage(card("a", { tokens: 36222, tool_uses: 1 })), "36.2K tokens · 1 次工具");
  assert.equal(subagentUsage(card("a")), "");
  assert.equal(subagentElapsed(card("a", { started_at: 1_000 }), 4_000), 3_000);
  assert.equal(subagentElapsed(card("a", { status: "completed", started_at: 1_000, ended_at: 2_500 }), 9_000), 1_500);
  assert.equal(subagentElapsed(card("a", { status: "completed", duration_ms: 8_251, started_at: 1_000 }), 9_000), 8_251);
  assert.equal(subagentElapsed(card("a", { status: "completed" }), 9_000), null);
});

test("the result is not repeated when it is the last answer in the steps", () => {
  const answer = event("a", 1, { kind: "agent-message", text: "PING\n" });
  assert.equal(subagentResultShown(card("a", { result: "PING" }), [answer]), "");
  assert.equal(subagentResultShown(card("a", { result: "汇总" }), [answer]), "汇总");
  assert.equal(subagentResultShown(card("a", { result: "PING" }), []), "PING");
});

test("group summary counts each status", () => {
  const summary = subagentGroupSummary([
    card("a", { status: "completed" }),
    card("b", { status: "running" }),
    card("c", { status: "completed" }),
  ]);
  assert.equal(summary, "3 个子 Agent · 1 个运行中 · 2 个完成");
});

test("adjacent cards fold into one group; thinking does not split it", () => {
  const pieces = foldActivity([
    card("a"),
    event("t", 2, { kind: "thinking", text: "想" }),
    card("b"),
    event("m", 3, { kind: "agent-message", text: "等它们" }),
    card("c"),
  ]);
  assert.deepEqual(
    pieces.map((piece) => (piece.type === "subagents" ? piece.cards.map((item) => item.subagent_id) : piece.type)),
    [["a", "b"], "event", ["c"]],
  );
});

test("subagent steps stay out of the main timeline and cards stay outside the folded process", () => {
  const events = [
    event("u", 1, { kind: "user-message", text: "派两个" }),
    card("a", { id: "ca", ts: 2, status: "completed" }),
    event("s1", 3, { kind: "subagent-step", subagent_id: "a", step: { kind: "agent-message", text: "子回答" } }),
    event("tool", 4, { kind: "tool-call", name: "command", summary: "ls" }),
    event("m", 5, { kind: "agent-message", text: "两个都完了", phase: "final-answer" }),
    event("done", 6, { kind: "status-changed", status: "completed" }),
  ];
  const blocks = buildTimeline(events, "completed");
  const turn = blocks.find((block) => block.type === "turn");
  assert.ok(turn && turn.type === "turn");
  assert.ok(!turn.events.some((item) => item.kind === "subagent-step"));
  assert.ok(turn.events.some((item) => item.kind === "subagent"));
  assert.equal(turn.answerId, "m");
});
