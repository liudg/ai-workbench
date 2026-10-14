import assert from "node:assert/strict";
import { test } from "node:test";

import { foldDiffLines } from "./fold.ts";
import { DIFF_AUTO_SPLIT_MIN_PX, diffPresentation, nextDiffLayout, toSplitRows } from "./split-rows.ts";
import { applyWordDiff } from "./word-diff.ts";

test("auto layout stays inline until the diff column is wide enough", () => {
  assert.equal(diffPresentation("auto", 0), "inline");
  assert.equal(diffPresentation("auto", DIFF_AUTO_SPLIT_MIN_PX - 1), "inline");
  assert.equal(diffPresentation("auto", DIFF_AUTO_SPLIT_MIN_PX), "split");
  assert.equal(diffPresentation("split", 200), "split");
  assert.equal(diffPresentation("inline", DIFF_AUTO_SPLIT_MIN_PX), "inline");
});

test("the side-by-side toolbar toggle flips the view the user is looking at", () => {
  assert.equal(nextDiffLayout("auto", DIFF_AUTO_SPLIT_MIN_PX), "inline");
  assert.equal(nextDiffLayout("inline", DIFF_AUTO_SPLIT_MIN_PX), "split");
  assert.equal(nextDiffLayout("split", 200), "inline");
  assert.equal(nextDiffLayout("auto", DIFF_AUTO_SPLIT_MIN_PX - 1), "split");
});

test("side-by-side pairs deletions with additions and keeps word highlights", () => {
  const diff = [
    "diff --git a/Library/GemFeedback/invoke.ps1 b/Library/GemFeedback/invoke.ps1",
    "--- a/Library/GemFeedback/invoke.ps1",
    "+++ b/Library/GemFeedback/invoke.ps1",
    "@@ -1,3 +1,3 @@",
    " keep",
    "-old value",
    "+new value",
  ].join("\n");
  const rows = toSplitRows(applyWordDiff(foldDiffLines(diff)));
  assert.deepEqual(
    rows.map((row) =>
      row.kind === "collapse" ? `hide ${row.count}` : `${row.left.tone}:${row.left.text}|${row.right.tone}:${row.right.text}`,
    ),
    ["context:keep|context:keep", "del:old value|add:new value"],
  );
  const changed = rows[1];
  assert.equal(changed?.kind, "pair");
  if (changed?.kind !== "pair") return;
  assert.equal(changed.left.parts?.some((part) => part.changed), true);
  assert.equal(changed.right.parts?.some((part) => part.changed), true);
});
