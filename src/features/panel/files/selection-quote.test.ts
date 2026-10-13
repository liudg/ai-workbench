import assert from "node:assert/strict";
import test from "node:test";

import { appendSnippet } from "../../../shared/composer-insert.ts";
import { formatSelectionQuote, lineRangeFromOffsets } from "./selection-quote.ts";

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

test("append snippet keeps existing composer text", () => {
  assert.equal(appendSnippet("", "```a.cs\nline\n```"), "```a.cs\nline\n```");
  assert.equal(appendSnippet("先看这个", "```a.cs\nline\n```"), "先看这个\n\n```a.cs\nline\n```");
});
