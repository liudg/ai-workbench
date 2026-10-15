import assert from "node:assert/strict";
import { test } from "node:test";

import { highlightLine } from "./highlight.ts";

test("a source line marks keywords, types, strings, comments, and numbers", () => {
  const tokens = highlightLine("public class Gem { int n = 4; // note");
  const kind = (text: string) => tokens.find((token) => token.text === text)?.kind;
  assert.equal(kind("public"), "keyword");
  assert.equal(kind("class"), "keyword");
  assert.equal(kind("Gem"), "type");
  assert.equal(kind("int"), "keyword");
  assert.equal(kind("4"), "number");
  assert.equal(tokens[tokens.length - 1]?.kind, "comment");
  assert.deepEqual(highlightLine("  // only"), [{ text: "  // only", kind: "comment" }]);
  const text = highlightLine('name = "gem"');
  assert.equal(text.some((token) => token.kind === "string" && token.text === '"gem"'), true);
});
