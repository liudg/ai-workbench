import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent } from "../../../types/index.ts";
import { eventKindDisposition, RENDERED_EVENT_KINDS, SILENT_EVENT_KINDS } from "./event-kinds.ts";

const ALL: SessionEvent["kind"][] = [
  "user-message",
  "agent-message",
  "thinking",
  "tool-call",
  "prompt",
  "prompt-resolved",
  "status-changed",
  "system",
  "read-only",
  "error",
  "turn-anchor",
  "turn-diff",
  "file-change",
  "turn-changes",
  "plan-steps",
  "plan-text",
  "review-note",
  "review-findings",
  "collaboration-mode",
  "goal",
  "context-usage",
];

test("every event kind is either rendered or silent", () => {
  const covered = new Set<string>([...RENDERED_EVENT_KINDS, ...SILENT_EVENT_KINDS]);
  assert.deepEqual([...covered].sort(), [...ALL].sort());
  assert.equal(RENDERED_EVENT_KINDS.length + SILENT_EVENT_KINDS.length, ALL.length);
  for (const kind of RENDERED_EVENT_KINDS) assert.equal(eventKindDisposition(kind), "render");
  for (const kind of SILENT_EVENT_KINDS) assert.equal(eventKindDisposition(kind), "silent");
});
