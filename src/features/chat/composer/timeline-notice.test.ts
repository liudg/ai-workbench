import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent } from "../../../types/event.ts";
import { shownInTimeline } from "./timeline-notice.ts";

const gone = "原来的对话已经不在了，可能已在别处删除，无法接着聊。";
const at = (seq: number, body: Record<string, unknown>) =>
  ({ id: `e${seq}`, session_id: "s", seq, ts: seq, ...body }) as SessionEvent;

test("a notice equal to the latest timeline error is not repeated", () => {
  const events = [
    at(1, { kind: "agent-message", text: "你好" }),
    at(2, { kind: "error", message: gone }),
    at(3, { kind: "status-changed", status: "failed" }),
  ];
  assert.equal(shownInTimeline(events, gone), true);
  assert.equal(shownInTimeline(events, "目标没推上去"), false);
});

test("an older error followed by other activity does not hide the notice", () => {
  const events = [
    at(1, { kind: "error", message: gone }),
    at(2, { kind: "user-message", text: "再试一次", images: [] }),
  ];
  assert.equal(shownInTimeline(events, gone), false);
  assert.equal(shownInTimeline([], gone), false);
});
