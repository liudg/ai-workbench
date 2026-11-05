import assert from "node:assert/strict";
import test from "node:test";

import { canCommentLine, diffSpanDraft, type DiffCommentLine } from "./diff-comments.ts";

const lines: (DiffCommentLine | null)[] = [
  { tone: "context", text: "a", lineNo: 10 },
  { tone: "del", text: "b", lineNo: 11 },
  { tone: "add", text: "c", lineNo: 11 },
  null,
  { tone: "pad", text: "", lineNo: null },
  { tone: "add", text: "d", lineNo: 40 },
];

test("diff comment keeps +/- and uses the first and last line numbers", () => {
  const draft = diffSpanDraft(lines, 0, 2, "/p/a.ts");
  assert.equal(draft?.body, " a\n-b\n+c");
  assert.equal(draft?.start, 10);
  assert.equal(draft?.end, 11);
  assert.equal(draft?.quote, "```10:11:/p/a.ts\n a\n-b\n+c\n```");
});

test("collapsed rows and padding are skipped", () => {
  const draft = diffSpanDraft(lines, 2, 5, "a.ts");
  assert.equal(draft?.body, "+c\n+d");
  assert.equal(draft?.end, 40);
  assert.equal(diffSpanDraft(lines, 3, 4, "a.ts"), null);
  assert.equal(canCommentLine(lines[4]), false);
  assert.equal(canCommentLine({ tone: "meta", text: "@@", lineNo: null }), false);
});

test("locations use the current file's numbers unless only deleted lines are picked", () => {
  const rows: DiffCommentLine[] = [
    { tone: "del", text: "old", lineNo: 30 },
    { tone: "add", text: "new", lineNo: 12 },
  ];
  assert.equal(diffSpanDraft(rows, 0, 1, "a.ts")?.start, 12);
  assert.equal(diffSpanDraft(rows, 0, 1, "a.ts")?.end, 12);
  assert.equal(diffSpanDraft(rows, 0, 0, "a.ts")?.start, 30);
});
