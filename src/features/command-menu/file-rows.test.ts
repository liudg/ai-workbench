import assert from "node:assert/strict";
import { test } from "node:test";

import { fileRows } from "./file-rows.ts";

test("file rows show the name and the directory", () => {
  const rows = fileRows(["src/App.tsx", "README.md", "src\\sidebar\\Sidebar.tsx"]);
  assert.equal(rows[0]?.label, "App.tsx");
  assert.equal(rows[0]?.detail, "src");
  assert.equal(rows[0]?.filePath, "src/App.tsx");
  assert.equal(rows[0]?.kind, "file");
  assert.equal(rows[1]?.label, "README.md");
  assert.equal(rows[1]?.detail, undefined);
  assert.equal(rows[2]?.filePath, "src/sidebar/Sidebar.tsx");
  assert.equal(rows[2]?.detail, "src/sidebar");
});
