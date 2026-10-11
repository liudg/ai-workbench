import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent, SessionEventBody } from "../../../types.ts";
import { diffStats, diffSummary, isReviewDuplicate } from "./codex-turn.ts";

function event(id: string, seq: number, body: SessionEventBody): SessionEvent {
  return { id, session_id: "s", seq, ts: seq, ...body };
}

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
  assert.equal(diffSummary(diff), "1 个文件已更改  +2  -1");
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
