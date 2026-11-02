import assert from "node:assert/strict";
import { test } from "node:test";

import { isShellLang } from "./shell-lang.ts";

test("shell fences are runnable, other languages are not", () => {
  assert.equal(isShellLang("bash"), true);
  assert.equal(isShellLang("PowerShell"), true);
  assert.equal(isShellLang("sh title=run.sh"), true);
  assert.equal(isShellLang("ts"), false);
  assert.equal(isShellLang(""), false);
});
