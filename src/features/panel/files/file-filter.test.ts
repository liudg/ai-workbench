import assert from "node:assert/strict";
import { test } from "node:test";

import { filterFiles } from "./file-filter.ts";

test("file filter matches the path and ignores case", () => {
  const files = [{ path: "Tools/Lab/A.ts" }, { path: "readme.txt" }];
  assert.deepEqual(
    filterFiles(files, " lab ").map((file) => file.path),
    ["Tools/Lab/A.ts"],
  );
  assert.equal(filterFiles(files, "  ").length, 2);
});
