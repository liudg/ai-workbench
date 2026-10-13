import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent, SessionEventBody } from "../../../types/index.ts";
import { collaborationMode, exclusiveComposerMode } from "./collaboration-mode.ts";

function event(id: string, seq: number, body: SessionEventBody): SessionEvent {
  return { id, session_id: "s", seq, ts: seq, ...body };
}

test("plan mode follows the latest collaboration event", () => {
  const events = [
    event("1", 1, { kind: "collaboration-mode", mode: "plan" }),
    event("2", 2, { kind: "collaboration-mode", mode: "default" }),
  ];
  assert.equal(collaborationMode(events), "default");
  assert.equal(collaborationMode([]), "default");
});

test("plan and goal cannot both occupy the composer", () => {
  const plan = event("plan", 1, { kind: "collaboration-mode", mode: "plan" });
  const goal = event("goal", 2, { kind: "goal", objective: "把测试补上", status: "active" });
  assert.equal(exclusiveComposerMode([plan], { draft: true, live: false }), "goal");
  assert.equal(exclusiveComposerMode([plan, goal], { draft: false, live: true }), "goal");
  assert.equal(exclusiveComposerMode([goal, plan], { draft: false, live: true }), "plan");
  assert.equal(exclusiveComposerMode([plan], { draft: false, live: false }), "plan");
  assert.equal(exclusiveComposerMode([], { draft: false, live: false }), "default");
});
