import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent, SessionEventBody } from "../../../types/index.ts";
import { collaborationMode } from "./collaboration-mode.ts";

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
