import assert from "node:assert/strict";
import { test } from "node:test";

import { toggleFollowUpQueueMode } from "./follow-up-queue-mode.ts";

test("toggle only flips the mode", () => {
  assert.equal(toggleFollowUpQueueMode("queue"), "steer");
  assert.equal(toggleFollowUpQueueMode("steer"), "queue");
});
