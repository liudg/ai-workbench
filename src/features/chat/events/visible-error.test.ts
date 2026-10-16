import assert from "node:assert/strict";
import { test } from "node:test";

import { visibleErrorText } from "./visible-error.ts";

test("opaque error placeholders are not shown", () => {
  assert.equal(visibleErrorText("  "), null);
  assert.equal(visibleErrorText("unknown"), null);
  assert.equal(visibleErrorText("Unknown Error"), null);
  assert.equal(visibleErrorText("null"), null);
  assert.equal(visibleErrorText('{"error":"unknown"}'), null);
  assert.equal(visibleErrorText("Claude Code 连接中断"), "Claude Code 连接中断");
  assert.equal(visibleErrorText("Error: 限额"), "Error: 限额");
});
