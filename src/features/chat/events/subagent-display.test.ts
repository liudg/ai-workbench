import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent, SessionEventBody } from "../../../types/index.ts";
import { buildTimeline, foldedEvents } from "../timeline/timeline.ts";
import { foldActivity } from "./activity-fold.ts";
import {
  subagentDetail,
  subagentElapsed,
  subagentMeta,
  subagentResultShown,
  subagentSteps,
  subagentTimeline,
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

test("subagent cards split tool groups", () => {
  const pieces = foldActivity([
    event("k1", 1, { kind: "tool-call", name: "command", summary: "ls" }),
    card("a"),
    event("k2", 2, { kind: "tool-call", name: "command", summary: "pwd" }),
  ]);
  assert.deepEqual(pieces.map((piece) => piece.type), ["tools", "event", "tools"]);
});

test("an ended card without an end event remains a single line", () => {
  const blocks = buildTimeline(
    [
      event("u", 1, { kind: "user-message", text: "派一个" }),
      card("a", { id: "ca", ts: 2, status: "failed" }),
      event("m", 5, { kind: "agent-message", text: "结束了", phase: "final-answer" }),
      event("done", 6, { kind: "status-changed", status: "completed" }),
    ],
    "completed",
  );
  const turn = blocks.find((block) => block.type === "turn");
  assert.ok(turn && turn.type === "turn");
  assert.deepEqual(turn.events.map((item) => item.kind), ["subagent", "agent-message"]);
});

test("subagent completion updates the original rows without adding end markers", () => {
  const build = card("build", { id: "build-card", ts: 2 });
  const review = card("review", { id: "review-card", ts: 3 });
  const events = [
    event("u", 1, { kind: "user-message", text: "开始" }),
    build,
    review,
    event("m", 4, { kind: "agent-message", text: "进度" }),
  ];
  const visible = (input: SessionEvent[], status: "running" | "completed") =>
    buildTimeline(input, status).flatMap((block) => block.type === "event" ? [block.event] : block.events);
  const before = visible(events, "running");
  for (const status of ["completed", "failed", "stopped"] as const) {
    const updated = [
      events[0],
      { ...build, status },
      review,
      events[3],
      event("end", 5, { kind: "subagent-ended", subagent_id: "build", title: build.title, status }),
    ];
    for (const sessionStatus of ["running", "completed"] as const) {
      const after = visible(updated, sessionStatus);
      assert.deepEqual(after.map((item) => item.id), before.map((item) => item.id));
      assert.equal(after[1].kind === "subagent" && after[1].status, status);
      assert.equal(after[2].kind === "subagent" && after[2].status, "running");
    }
  }
});

test("subagent steps stay out of the main timeline and lines fold with the process", () => {
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
  assert.deepEqual(foldedEvents(turn.events, true).map((item) => item.id), ["m"]);
});

test("opening a subagent shows its prompt as the first message, its steps, and the result once", () => {
  const steps = [...(subagentSteps([
    event("a1", 2, { kind: "subagent-step", subagent_id: "a", step: { kind: "tool-call", name: "command", summary: "echo PING" } }),
    event("a2", 3, { kind: "subagent-step", subagent_id: "a", step: { kind: "agent-message", text: "PING" } }),
  ]).get("a") ?? [])];
  const done = card("a", { prompt: "Run echo PING", status: "completed", result: "PING", started_at: 1, ended_at: 9 });
  const kinds = subagentTimeline(done, steps).map((item) => item.kind);
  assert.deepEqual(kinds, ["user-message", "turn-anchor", "tool-call", "agent-message", "status-changed"]);

  // 没有步骤时结果补成最后一句回答；还在跑时不收尾。
  const running = card("b", { prompt: "", status: "running", result: "" });
  assert.deepEqual(subagentTimeline(running, []).map((item) => item.kind), ["turn-anchor"]);
  const bare = card("c", { status: "failed", result: "boom" });
  const tail = subagentTimeline(bare, []).slice(-2);
  assert.equal(tail[0]?.kind, "agent-message");
  assert.deepEqual(tail[1], { ...tail[1], kind: "status-changed", status: "failed" });
});

test("a row's second line is what it is doing while running and its result after", () => {
  assert.equal(subagentDetail(card("a", { status: "running", activity: "Read  src/a.ts", result: "x" })), "Read src/a.ts");
  assert.equal(subagentDetail(card("a", { status: "completed", activity: "", result: "done\nnext" })), "done next");
});
