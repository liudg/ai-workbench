import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent, SessionEventBody } from "../../../types.ts";
import {
  collaborationMode,
  diffStats,
  diffSummary,
  isReviewDuplicate,
  latestRevertTarget,
} from "./codex-turn.ts";

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

test("only the latest anchored user message can be edited", () => {
  const events = [
    event("u1", 1, { kind: "user-message", text: "first" }),
    event("a1", 2, { kind: "turn-anchor", turn_id: "old" }),
    event("u2", 3, { kind: "user-message", text: "second" }),
    event("a2", 4, { kind: "turn-anchor", turn_id: "new" }),
  ];
  assert.deepEqual(latestRevertTarget(events), { turnId: "new", userEventId: "u2" });
});

test("unified diff counts files and lines without a horizontal scroller", () => {
  const diff = [
    "diff --git a/src/main.rs b/src/main.rs",
    "--- a/src/main.rs",
    "+++ b/src/main.rs",
    "@@ -1 +1,2 @@",
    "-fn main() {}",
    "+fn main() {",
    "+}",
  ].join("\n");
  assert.deepEqual(diffStats(diff), { files: 1, added: 2, removed: 1 });
  assert.equal(diffSummary(diff), "1 file changed  +2  −1");
});

test("hides the agent message that repeats the review text", () => {
  const raw = "The change looks safe.";
  const events = [
    event("1", 1, { kind: "user-message", text: "Review uncommitted changes" }),
    event("2", 2, {
      kind: "review-findings",
      summary: raw,
      raw,
      findings: [],
    }),
    event("3", 3, { kind: "agent-message", text: raw }),
  ];
  assert.equal(isReviewDuplicate(events, 2), true);
  assert.equal(isReviewDuplicate(events, 1), false);
});
