import assert from "node:assert/strict";
import test from "node:test";

import { userFacingMessage } from "./user-facing.ts";

test("null and raw errors stay off the screen", () => {
  assert.equal(userFacingMessage(null), null);
  assert.equal(userFacingMessage(undefined), null);
  assert.equal(userFacingMessage("null"), null);
  assert.equal(userFacingMessage(" undefined "), null);
  assert.equal(userFacingMessage(new Error("null")), null);
  assert.equal(userFacingMessage("SyntaxError: Unexpected token"), null);
  assert.equal(userFacingMessage('{"error":"nope"}'), null);
  assert.equal(userFacingMessage("Error: boom\n    at load (catalog.ts:1:1)"), null);
  assert.equal(userFacingMessage("等待 Codex model/list 超时"), "等待 Codex model/list 超时");
});
