import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent, SessionEventBody } from "../../../types/index.ts";
import { activeGoal } from "./goal.ts";

function event(id: string, seq: number, body: SessionEventBody): SessionEvent {
  return { id, session_id: "s", seq, ts: seq, ...body };
}

test("the goal chip follows the latest goal event", () => {
  assert.equal(activeGoal([]), null);
  const events = [
    event("1", 1, { kind: "goal", objective: "把测试补上", status: "active" }),
    event("2", 2, { kind: "goal", objective: null }),
  ];
  assert.equal(activeGoal(events), null);
  assert.deepEqual(activeGoal(events.slice(0, 1)), {
    objective: "把测试补上",
    status: "active",
  });
});
