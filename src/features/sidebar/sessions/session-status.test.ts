import assert from "node:assert/strict";
import { test } from "node:test";

import { isPinnedSession } from "./session-status.ts";

test("only running and waiting sessions pin", () => {
  assert.equal(isPinnedSession("running"), true);
  assert.equal(isPinnedSession("needs-input"), true);
  assert.equal(isPinnedSession("completed"), false);
  assert.equal(isPinnedSession("failed"), false);
  assert.equal(isPinnedSession("stopped"), false);
  assert.equal(isPinnedSession(null), false);
  assert.equal(isPinnedSession(undefined), false);
});
