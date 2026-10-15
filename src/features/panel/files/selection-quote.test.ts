import assert from "node:assert/strict";
import test from "node:test";

import { formatSelectionQuote, lineRangeFromOffsets, selectionDraft } from "./selection-quote.ts";

test("selection quote keeps the path and line range", () => {
  const quote = formatSelectionQuote(
    "Assets/Editor/ResMgrMainView.cs",
    "    private static void Show()\n    {\n",
    12,
    13,
  );
  assert.equal(
    quote,
    "```12:13:Assets/Editor/ResMgrMainView.cs\n    private static void Show()\n    {\n```",
  );
  assert.equal(formatSelectionQuote("a.cs", "   \n", 1, 1), "");
  assert.equal(formatSelectionQuote("a.cs", "using UnityEngine;", null, null), "```a.cs\nusing UnityEngine;\n```");
});

test("line range follows newlines in the file", () => {
  const source = "one\ntwo\nthree\n";
  assert.deepEqual(lineRangeFromOffsets(source, 4, 7), { start: 2, end: 2 });
  assert.deepEqual(lineRangeFromOffsets(source, 0, 8), { start: 1, end: 3 });
});

test("selection draft keeps the body out of the fence", () => {
  const draft = selectionDraft("a.cs", "using UnityEngine;\n", null, null);
  assert.ok(draft);
  assert.equal(draft.body, "using UnityEngine;");
  assert.equal(draft.quote, "```a.cs\nusing UnityEngine;\n```");
  assert.equal(draft.start, null);
  const ranged = selectionDraft("a.cs", "line\n", 4, 2);
  assert.equal(ranged?.start, 2);
  assert.equal(ranged?.end, 4);
  assert.equal(selectionDraft("a.cs", "   \n", 1, 1), null);
});
