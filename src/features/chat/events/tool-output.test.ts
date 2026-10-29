import assert from "node:assert/strict";
import { test } from "node:test";

import { commandIsLong, outputPreview } from "./tool-output.ts";

test("short output is kept whole", () => {
  assert.deepEqual(outputPreview("a\nb"), { text: "a\nb", hiddenLines: 0 });
});

test("long output keeps the tail and counts what was dropped", () => {
  const lines = Array.from({ length: 500 }, (_, index) => `line ${index}`);
  const preview = outputPreview(lines.join("\n"));
  assert.equal(preview.hiddenLines, 380);
  assert.ok(preview.text.startsWith("line 380\n"));
  assert.ok(preview.text.endsWith("line 499"));
});

test("a few very long lines are trimmed by size", () => {
  const preview = outputPreview(["x".repeat(5_000), "y".repeat(5_000), "z".repeat(10)].join("\n"));
  assert.equal(preview.hiddenLines, 1);
  assert.ok(preview.text.startsWith("y"));
  const single = outputPreview("q".repeat(20_000));
  assert.equal(single.text.length, 8_000);
});

test("commands over three lines or very long are folded", () => {
  assert.equal(commandIsLong("git status"), false);
  assert.equal(commandIsLong("a\nb\nc\nd"), true);
  assert.equal(commandIsLong("x".repeat(300)), true);
});
