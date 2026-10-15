import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FOLLOW_UP_QUEUE_MODE_KEY,
  readFollowUpQueueMode,
  readSessionFollowUpQueueMode,
  rememberFollowUpQueueMode,
  toggleFollowUpQueueMode,
  writeSessionFollowUpQueueMode,
  type ModeStorage,
} from "./follow-up-queue-mode.ts";

function memory(): ModeStorage & { raw: Record<string, string> } {
  const raw: Record<string, string> = {};
  return {
    raw,
    getItem: (key) => raw[key] ?? null,
    setItem: (key, value) => {
      raw[key] = value;
    },
  };
}

test("session mode wins over the agent memory", () => {
  const storage = memory();
  rememberFollowUpQueueMode(storage, "s-old", "codex-cli", "steer");
  writeSessionFollowUpQueueMode(storage, "s-new", "queue");
  assert.equal(readFollowUpQueueMode(storage, "s-new", "codex-cli"), "queue");
  assert.equal(readFollowUpQueueMode(storage, "s-fresh", "codex-cli"), "steer");
  assert.equal(readFollowUpQueueMode(storage, "s-fresh", "claude-code"), "queue");
  assert.equal(readSessionFollowUpQueueMode(storage, "s-fresh"), null);
});

test("toggle only flips the mode", () => {
  assert.equal(toggleFollowUpQueueMode("queue"), "steer");
  assert.equal(toggleFollowUpQueueMode("steer"), "queue");
});

test("broken storage falls back to queue", () => {
  const storage = memory();
  storage.raw[FOLLOW_UP_QUEUE_MODE_KEY] = "{";
  assert.equal(readFollowUpQueueMode(storage, "s", "codex-cli"), "queue");
  assert.equal(readFollowUpQueueMode(null, "s", "codex-cli"), "queue");
});
