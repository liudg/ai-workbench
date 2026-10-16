import assert from "node:assert/strict";
import { test } from "node:test";

import { isImeKey } from "./keyboard.ts";

test("ime keys include composition and the 229 placeholder", () => {
  assert.equal(isImeKey({ composing: true, keyCode: 13 }), true);
  assert.equal(isImeKey({ composing: false, keyCode: 229 }), true);
  assert.equal(isImeKey({ composing: false, keyCode: 13 }), false);
  assert.equal(isImeKey({}), false);
});
