import assert from "node:assert/strict";
import { test } from "node:test";

import { pathsWithFileOpen } from "./reveal-file.ts";

test("revealing a collapsed file opens only that path", () => {
  assert.deepEqual(pathsWithFileOpen([], "a.ts"), ["a.ts"]);
  assert.deepEqual(pathsWithFileOpen(["b.ts"], "a.ts"), ["b.ts", "a.ts"]);
  const open = ["a.ts"];
  assert.equal(pathsWithFileOpen(open, "a.ts"), open);
  assert.equal(pathsWithFileOpen(open, ""), open);
});
