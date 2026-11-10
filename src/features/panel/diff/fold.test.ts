import assert from "node:assert/strict";
import { test } from "node:test";

import { diffBodyRows } from "./diff-body.ts";
import { expandDiffLines, foldDiffLines } from "./fold.ts";
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

test("hunk rows keep old and new line numbers", () => {
  const diff = ["@@ -1,3 +1,4 @@", " import { Panel } from './panel';", "-export const width = 320;", "+export const width = 480;", "+export const minWidth = 360;", " "].join("\n");
  const rows = foldDiffLines(diff).filter((row) => row.kind === "line");
  assert.deepEqual(
    rows.map((row) => (row.kind === "line" ? `${row.tone}:${row.oldNo ?? ""}:${row.newNo ?? ""}:${row.text}` : "")),
    [
      "context:1:1:import { Panel } from './panel';",
      "del:2::export const width = 320;",
      "add::2:export const width = 480;",
      "add::3:export const minWidth = 360;",
      "context:3:4:",
    ],
  );
});

test("the newline that ends the diff text is not an extra context row", () => {
  const diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+BETA\n";
  const rows = foldDiffLines(diff).filter((row) => row.kind === "line");
  assert.deepEqual(
    rows.map((row) => (row.kind === "line" ? `${row.tone}:${row.oldNo ?? ""}:${row.newNo ?? ""}:${row.text}` : "")),
    ["context:1:1:alpha", "del:2::beta", "add::2:BETA"],
  );
  const expanded = expandDiffLines(diff, "alpha\nBETA\n");
  assert.equal(expanded?.filter((row) => row.kind === "line").length, 3);
});

test("whitespace-only edits drop out and expand fills the new file", () => {
  const spaced = ["@@ -1,2 +1,2 @@", "-a b", "+a  b", " same"].join("\n");
  assert.equal(texts(body(spaced, { hideWhitespace: true })).includes("add:a  b"), false);
  const kept = ["@@ -1 +1 @@", "-old", "+new"].join("\n");
  assert.equal(texts(body(kept, { hideWhitespace: true })).includes("add:new"), true);

  const source = ["one", "TWO", "three"].join("\n");
  const diff = ["@@ -2 +2 @@", "-two", "+TWO"].join("\n");
  const rows = expandDiffLines(diff, source) ?? [];
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
  assert.deepEqual(texts(body(diff, { hideImports: true })), ["context:keep", "add:added"]);
});

test("add-only and delete-only file bodies render as inserts and deletions", () => {
  const added = diffBodyRows({
    diff: "public class AdjustPrefab\n{\n    void Apply() {}\n}",
    status: "A",
    added: 4,
    removed: 0,
    source: "should not replace the added body",
    loadFull: true,
    hideWhitespace: true,
    hideImports: false,
  });
  assert.equal(added.whitespaceHidden, false);
  assert.deepEqual(
    added.rows.map((row) => (row.kind === "line" ? `${row.tone}:${row.text}` : "hide")),
    ["add:public class AdjustPrefab", "add:{", "add:    void Apply() {}", "add:}"],
  );
  const removed = diffBodyRows({
    diff: "gone\nstill gone",
    status: "D",
    added: 0,
    removed: 2,
    source: null,
    loadFull: false,
    hideWhitespace: false,
    hideImports: false,
  });
  assert.deepEqual(
    removed.rows.map((row) => (row.kind === "line" ? row.tone : "hide")),
    ["del", "del"],
  );
  const unified = diffBodyRows({
    diff: ["@@ -0,0 +1,2 @@", "+one", "+two"].join("\n"),
    status: "A",
    added: 2,
    removed: 0,
    source: null,
    loadFull: false,
    hideWhitespace: false,
    hideImports: false,
  });
  assert.deepEqual(
    unified.rows.filter((row) => row.kind === "line").map((row) => (row.kind === "line" ? row.text : "")),
    ["one", "two"],
  );
});

test("hiding whitespace drops only lines that differ by spaces", () => {
  const split = ["@@ -1,2 +1,2 @@", "-ab", "-c", "+a", "+bc"].join("\n");
  const splitBody = diffBodyRows({
    diff: split,
    status: "M",
    added: 2,
    removed: 2,
    source: null,
    loadFull: false,
    hideWhitespace: true,
    hideImports: false,
  });
  assert.equal(splitBody.whitespaceHidden, false);
  assert.deepEqual(
    splitBody.rows.filter((row) => row.kind === "line").map((row) => (row.kind === "line" ? `${row.tone}:${row.text}` : "")),
    ["del:ab", "del:c", "add:a", "add:bc"],
  );

  const mixed = ["@@ -1,3 +1,3 @@", " head", "-a b", "-old", "+a  b", "+new", " tail"].join("\n");
  const mixedBody = diffBodyRows({
    diff: mixed,
    status: "M",
    added: 2,
    removed: 2,
    source: null,
    loadFull: false,
    hideWhitespace: true,
    hideImports: false,
  });
  assert.equal(mixedBody.whitespaceHidden, false);
  assert.deepEqual(
    mixedBody.rows.filter((row) => row.kind === "line").map((row) => (row.kind === "line" ? `${row.tone}:${row.text}` : "")),
    ["context:head", "del:old", "add:new", "context:tail"],
  );
});

test("a new or deleted file still renders when the diff has no hunk header", () => {
  const added = diffBodyRows({
    diff: ["diff --git a/fresh.txt b/fresh.txt", "new file mode 100644", "--- /dev/null", "+++ b/fresh.txt", "+one", "+two"].join(
      "\n",
    ),
    status: "A",
    added: 2,
    removed: 0,
    source: null,
    loadFull: false,
    hideWhitespace: false,
    hideImports: false,
  });
  assert.deepEqual(
    added.rows.filter((row) => row.kind === "line").map((row) => (row.kind === "line" ? `${row.tone}:${row.text}` : "")),
    ["add:one", "add:two"],
  );
  const removed = diffBodyRows({
    diff: ["diff --git a/old.txt b/old.txt", "deleted file mode 100644", "--- a/old.txt", "-gone"].join("\n"),
    status: "D",
    added: 0,
    removed: 1,
    source: null,
    loadFull: false,
    hideWhitespace: false,
    hideImports: false,
  });
  assert.deepEqual(
    removed.rows.filter((row) => row.kind === "line").map((row) => (row.kind === "line" ? `${row.tone}:${row.text}` : "")),
    ["del:gone"],
  );
});

test("hiding whitespace keeps a whitespace-only diff marked instead of empty of files", () => {
  const body = diffBodyRows({
    diff: ["@@ -1 +1 @@", "-a b", "+a  b"].join("\n"),
    status: "M",
    added: 1,
    removed: 1,
    source: "a  b",
    loadFull: true,
    hideWhitespace: true,
    hideImports: false,
  });
  assert.equal(body.whitespaceHidden, true);
  assert.equal(body.rows.length, 0);
  const kept = diffBodyRows({
    diff: ["@@ -1 +1 @@", "-old", "+new"].join("\n"),
    status: "M",
    added: 1,
    removed: 1,
    source: null,
    loadFull: false,
    hideWhitespace: true,
    hideImports: false,
  });
  assert.equal(kept.whitespaceHidden, false);
  assert.equal(kept.rows.some((row) => row.kind === "line" && row.tone === "add" && row.text === "new"), true);
});

const IMPORTED = [
  "@@ -1,3 +1,4 @@",
  "+import x from 'x';",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
].join("\n");

test("hiding imports keeps the line numbers of the rows that stay", () => {
  const expected = [
    "1/2 context const a = 1;",
    "2/. del const b = 2;",
    "./3 add const b = 3;",
    "3/4 context const c = 4;",
  ];
  assert.deepEqual(numbered(body(IMPORTED, { hideImports: true })), expected);
  const source = "import x from 'x';\nconst a = 1;\nconst b = 3;\nconst c = 4;\n";
  assert.deepEqual(numbered(body(IMPORTED, { hideImports: true, source, loadFull: true })), expected);
});

test("full text that no longer matches the diff falls back to the folded diff", () => {
  const stale = "import x from 'x';\nconst a = 1;\nconst b = 99;\nconst c = 4;\n";
  assert.equal(expandDiffLines(IMPORTED, stale), null);
  const rows = numbered(body(IMPORTED, { source: stale, loadFull: true }));
  assert.equal(rows.includes("./3 add const b = 3;"), true);
  assert.equal(rows.some((row) => row.includes("99")), false);
});

function body(
  diff: string,
  options: { hideImports?: boolean; hideWhitespace?: boolean; source?: string; loadFull?: boolean },
) {
  return diffBodyRows({
    diff,
    status: "M",
    added: 1,
    removed: 1,
    source: options.source ?? null,
    loadFull: options.loadFull ?? false,
    hideWhitespace: options.hideWhitespace ?? false,
    hideImports: options.hideImports ?? false,
  });
}

function texts(result: ReturnType<typeof diffBodyRows>): string[] {
  return result.rows.flatMap((row) => (row.kind === "line" ? [`${row.tone}:${row.text}`] : []));
}

function numbered(result: ReturnType<typeof diffBodyRows>): string[] {
  return result.rows.flatMap((row) =>
    row.kind === "line" ? [`${row.oldNo ?? "."}/${row.newNo ?? "."} ${row.tone} ${row.text}`] : [],
  );
}
