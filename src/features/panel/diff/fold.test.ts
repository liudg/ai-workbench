import assert from "node:assert/strict";
import { test } from "node:test";

import { expandDiffLines, foldDiffLines, withoutImportLines, withoutWhitespaceChanges } from "./fold.ts";
import { applyWordDiff } from "./word-diff.ts";

test("unchanged lines between hunks collapse into unmodified bars", () => {
  const diff = [
    "diff --git a/annotate.html b/annotate.html",
    "--- a/annotate.html",
    "+++ b/annotate.html",
    "@@ -11,3 +11,4 @@",
    " p.note { color: #555; }",
    "+#p1 { font-size: 18px; }",
    " </",
    "@@ -22,1 +23,2 @@",
    "-</html>",
    "\\ No newline at end of file",
    "+</html>",
  ].join("\n");
  const rows = foldDiffLines(diff);
  assert.deepEqual(
    rows.map((row) =>
      row.kind === "collapse" ? `hide ${row.count}` : `${row.tone}:${row.lineNo}:${row.text}`,
    ),
    [
      "hide 10",
      "context:11:p.note { color: #555; }",
      "add:12:#p1 { font-size: 18px; }",
      "context:13:</",
      "hide 8",
      "del:22:</html>",
      "meta:null:No newline at end of file",
      "add:23:</html>",
    ],
  );
});

test("whitespace-only edits drop out and expand fills the new file", () => {
  const spaced = ["@@ -1 +1 @@", "-a b", "+a  b", " same"].join("\n");
  assert.equal(withoutWhitespaceChanges(spaced).includes("+a  b"), false);
  const kept = ["@@ -1 +1 @@", "-old", "+new"].join("\n");
  assert.equal(withoutWhitespaceChanges(kept).includes("+new"), true);

  const source = ["one", "TWO", "three"].join("\n");
  const diff = ["@@ -2 +2 @@", "-two", "+TWO"].join("\n");
  const rows = expandDiffLines(diff, source);
  assert.equal(rows.some((row) => row.kind === "collapse"), false);
  assert.deepEqual(
    rows.map((row) => (row.kind === "line" ? `${row.tone}:${row.lineNo}:${row.text}` : "hide")),
    ["context:1:one", "del:2:two", "add:2:TWO", "context:3:three"],
  );
  const words = applyWordDiff(rows).filter((row) => row.kind === "line" && row.parts);
  const add = words.find((row) => row.kind === "line" && row.tone === "add");
  assert.equal(add?.kind === "line" && add.parts?.some((part) => part.changed && part.text === "TWO"), true);
});

test("hiding imports drops import lines and keeps the rest of the diff", () => {
  const diff = ["@@ -1,3 +1,3 @@", "-import a", "+import b", " keep", "+added"].join("\n");
  const next = withoutImportLines(diff);
  assert.equal(next.includes("import"), false);
  assert.equal(next.includes("keep"), true);
  assert.equal(next.includes("+added"), true);
  assert.equal(next.includes("@@"), true);
});
