import assert from "node:assert/strict";
import { test } from "node:test";

import { filterFiles, getFileFilter, resetFileFilters, setFileFilter } from "./file-filter.ts";

test("file filter matches the path and ignores case", () => {
  const files = [{ path: "Tools/Lab/A.ts" }, { path: "readme.txt" }];
  assert.deepEqual(
    filterFiles(files, " lab ").map((file) => file.path),
    ["Tools/Lab/A.ts"],
  );
  assert.equal(filterFiles(files, "  ").length, 2);
});

test("file filter stays inside the session that set it", () => {
  resetFileFilters();
  setFileFilter("session-a", "lab");
  setFileFilter("session-b", "readme");
  assert.equal(getFileFilter("session-a"), "lab");
  assert.equal(getFileFilter("session-b"), "readme");
  setFileFilter("session-a", "");
  assert.equal(getFileFilter("session-a"), "");
  assert.equal(getFileFilter("session-b"), "readme");
  resetFileFilters();
});
