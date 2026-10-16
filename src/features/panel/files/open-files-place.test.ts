import assert from "node:assert/strict";
import { test } from "node:test";

import { clearOpenFilesOnScope, openFilesPlace } from "./open-files-place.ts";

test("open files place reads a saved path and ignores a blank line", () => {
  assert.deepEqual(openFilesPlace({ title: "打开文件", path: "src/a.ts", line: 4 }), {
    path: "src/a.ts",
    line: 4,
  });
  assert.deepEqual(openFilesPlace({ title: "打开文件" }), { path: "", line: null });
  assert.deepEqual(openFilesPlace({ path: "a.ts", line: 0 }), { path: "a.ts", line: null });
  assert.deepEqual(openFilesPlace(null), { path: "", line: null });
});

test("switching projects in one session clears the open-files preview", () => {
  assert.equal(
    clearOpenFilesOnScope({ projectId: "a", sessionId: "s" }, { projectId: "b", sessionId: "s" }),
    true,
  );
  assert.equal(
    clearOpenFilesOnScope({ projectId: "a", sessionId: "s" }, { projectId: "a", sessionId: "other" }),
    false,
  );
  assert.equal(
    clearOpenFilesOnScope({ projectId: "a", sessionId: "s" }, { projectId: "a", sessionId: "s" }),
    false,
  );
});
