import assert from "node:assert/strict";
import { test } from "node:test";

import { atomArrow, atomDeleteRange, atomRanges, growSelection, snapCaret, withTrailingSpace } from "./composer-atoms.ts";
import { composerTokens } from "./file-refs.ts";

// "用 $pdf 读 @a.ts" → $pdf 在 2..6，@a.ts 在 9..14
const ranges = atomRanges(composerTokens("用 $pdf 读 @a.ts", [{ label: "@a.ts", path: "src/a.ts" }], ["pdf"]));

test("chips are located by their offsets in the text", () => {
  assert.deepEqual(ranges, [
    { start: 2, end: 6 },
    { start: 9, end: 14 },
  ]);
});

test("backspace right after a chip removes the whole chip", () => {
  assert.deepEqual(atomDeleteRange(ranges, 14, 14, "Backspace"), { start: 9, end: 14 });
  assert.deepEqual(atomDeleteRange(ranges, 6, 6, "Backspace"), { start: 2, end: 6 });
  assert.equal(atomDeleteRange(ranges, 7, 7, "Backspace"), null);
  assert.equal(atomDeleteRange(ranges, 2, 2, "Backspace"), null);
});

test("delete right before a chip removes the whole chip", () => {
  assert.deepEqual(atomDeleteRange(ranges, 9, 9, "Delete"), { start: 9, end: 14 });
  assert.equal(atomDeleteRange(ranges, 14, 14, "Delete"), null);
});

test("a selection that cuts into a chip takes the whole chip", () => {
  assert.deepEqual(atomDeleteRange(ranges, 4, 11, "Backspace"), { start: 2, end: 14 });
  assert.equal(atomDeleteRange(ranges, 2, 14, "Backspace"), null);
  assert.deepEqual(growSelection(ranges, 0, 3), { start: 0, end: 6 });
});

test("the caret never rests inside a chip", () => {
  assert.equal(snapCaret(ranges, 3), 2);
  assert.equal(snapCaret(ranges, 5), 6);
  assert.equal(snapCaret(ranges, 7), 7);
});

test("arrow keys step over a chip in one move", () => {
  assert.equal(atomArrow(ranges, 14, "ArrowLeft"), 9);
  assert.equal(atomArrow(ranges, 9, "ArrowRight"), 14);
  assert.equal(atomArrow(ranges, 8, "ArrowRight"), null);
  assert.equal(atomArrow(ranges, 9, "ArrowLeft"), null);
});

test("removing a chip between words does not leave a double space", () => {
  assert.deepEqual(withTrailingSpace("用 $pdf 读", { start: 2, end: 6 }), { start: 2, end: 7 });
  assert.deepEqual(withTrailingSpace("$pdf 读", { start: 0, end: 4 }), { start: 0, end: 5 });
  assert.deepEqual(withTrailingSpace("用 $pdf", { start: 2, end: 6 }), { start: 2, end: 6 });
  assert.deepEqual(withTrailingSpace("用$pdf 读", { start: 1, end: 5 }), { start: 1, end: 5 });
});
