import assert from "node:assert/strict";
import { test } from "node:test";

import { toolGlyph, toolLineText } from "./tool-line.ts";

test("tool line keeps the first non-empty summary line", () => {
  assert.equal(toolLineText("command", "rg --files\n已列出源码"), "rg --files");
  assert.equal(
    toolLineText("command", "  \nGet-Content -LiteralPath 'a.json' → completed"),
    "Get-Content -LiteralPath 'a.json' → completed",
  );
});

test("tool line falls back to the normalized name", () => {
  assert.equal(toolLineText("read_file", "   "), "read_file");
  assert.equal(toolLineText("  ", ""), "工具调用");
});

test("tool glyph follows normalized name and images", () => {
  assert.equal(toolGlyph("command", 0), "command");
  assert.equal(toolGlyph("read_file", 0), "tool");
  assert.equal(toolGlyph("command", 2), "image");
  assert.equal(toolGlyph("image", 1), "image");
});
