import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const status = readFileSync(new URL("./ThinkingStatus.tsx", import.meta.url), "utf8");
const stream = readFileSync(new URL("../timeline/ActivityStream.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../../../styles/globals.css", import.meta.url), "utf8");

test("in-progress thinking label shimmers on the words only", () => {
  assert.match(status, /data-thinking-status/);
  assert.match(status, /className="thinking-shimmer"/);
  assert.match(status, /DESKTOP_ZH\.activityThinkingNow/);
  assert.match(css, /@keyframes thinking-shimmer/);
  const rule = css.match(/\.thinking-shimmer\s*\{[^}]*\}/);
  assert.ok(rule, ".thinking-shimmer rule");
  assert.match(rule[0], /display:\s*inline-block/);
  assert.match(rule[0], /animation:\s*thinking-shimmer\b[^;]*alternate/);
  assert.match(rule[0], /background-clip:\s*text/);
});

test("reduced motion keeps the thinking label still and readable", () => {
  const block = css.match(
    /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.thinking-shimmer\s*\{[^}]*\}/,
  );
  assert.ok(block, "reduced-motion rule for .thinking-shimmer");
  assert.match(block[0], /animation:\s*none/);
  assert.match(block[0], /background-image:\s*none/);
  assert.match(block[0], /-webkit-text-fill-color:\s*#8a8a8a/);
});

test("the thinking line is mounted only while thinking is still in progress", () => {
  assert.match(stream, /\{thinking && !toolsOnly \? <ThinkingStatus \/> : null\}/);
});
