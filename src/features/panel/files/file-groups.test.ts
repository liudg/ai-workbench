import assert from "node:assert/strict";
import { test } from "node:test";

import { groupByDirectory } from "./file-groups.ts";
import { fileStatusTone } from "./path.ts";

test("file lists group by directory", () => {
  assert.deepEqual(
    groupByDirectory([
      { path: "Tools/Lab/a.ts" },
      { path: "Tools/Lab/b.ts" },
      { path: "readme.txt" },
    ]).map((group) => [group.dir, group.files.map((file) => file.path)]),
    [
      ["Tools/Lab", ["Tools/Lab/a.ts", "Tools/Lab/b.ts"]],
      ["", ["readme.txt"]],
    ],
  );
});

test("deletions use a distinct status tone", () => {
  assert.equal(fileStatusTone("M"), "add");
  assert.equal(fileStatusTone("A"), "add");
  assert.equal(fileStatusTone("D"), "del");
  assert.equal(fileStatusTone("R"), "neutral");
});
