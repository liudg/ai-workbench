import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent, SessionEventBody } from "../../types/index.ts";
import { steerFlags } from "./steer.ts";

function event(id: string, body: SessionEventBody): SessionEvent {
  return { id, session_id: "s", seq: 1, ts: 0, ...body };
}

test("only a message sent after the turn started working is a steer", () => {
  const flags = steerFlags([
    event("n1", { kind: "turn-anchor", turn_id: "t1" }),
    event("u1", { kind: "user-message", text: "开始" }),
    event("a1", { kind: "agent-message", text: "在做" }),
    event("u2", { kind: "user-message", text: "引导" }),
    event("s1", { kind: "status-changed", status: "completed" }),
    event("u3", { kind: "user-message", text: "下一轮" }),
    event("n2", { kind: "turn-anchor", turn_id: "t2" }),
    event("a2", { kind: "agent-message", text: "好" }),
  ]);
  assert.deepEqual(flags, [false, false, false, true, false, false, false, false]);
});

test("history without status events still splits at each turn anchor", () => {
  const flags = steerFlags([
    event("n1", { kind: "turn-anchor", turn_id: "t1" }),
    event("u1", { kind: "user-message", text: "开始" }),
    event("a1", { kind: "agent-message", text: "在做" }),
    event("u2", { kind: "user-message", text: "引导" }),
    event("n2", { kind: "turn-anchor", turn_id: "t2" }),
    event("u3", { kind: "user-message", text: "下一轮" }),
  ]);
  assert.deepEqual(flags, [false, false, false, true, false, false]);
});

test("agents that report no turn anchors never steer", () => {
  const flags = steerFlags([
    event("u1", { kind: "user-message", text: "一" }),
    event("a1", { kind: "agent-message", text: "答" }),
    event("u2", { kind: "user-message", text: "二" }),
  ]);
  assert.deepEqual(flags, [false, false, false]);
});
