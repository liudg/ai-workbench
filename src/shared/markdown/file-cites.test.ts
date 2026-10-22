import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { FILE_CITE_PREVIEW, FILE_CITE_SHOW_ALL, visibleFileCiteCount } from "./file-cites.ts";

test("file citations show every ref up to four, then three plus the rest", () => {
  assert.equal(FILE_CITE_SHOW_ALL, 4);
  assert.equal(FILE_CITE_PREVIEW, 3);
  assert.equal(visibleFileCiteCount(0, false), 0);
  assert.equal(visibleFileCiteCount(1, false), 1);
  assert.equal(visibleFileCiteCount(4, false), 4);
  assert.equal(visibleFileCiteCount(5, false), 3);
  assert.equal(visibleFileCiteCount(12, false), 3);
  assert.equal(visibleFileCiteCount(12, true), 12);
});

test("citation pills wrap in place and file lists stack instead of scrolling sideways", () => {
  const css = readFileSync(new URL("../../styles/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.answer-cite\s*\{[^}]*display:\s*inline-flex/);
  assert.match(css, /\.answer-cite\s*\{[^}]*border-radius:\s*0\.75rem/);
  assert.match(css, /\.answer-file-rows\s*\{[^}]*flex-direction:\s*column/);
  assert.match(css, /\.answer-file-row\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.equal(css.includes(".answer-file-list"), true);
  assert.equal(/\.answer-file-list\s*\{[^}]*overflow-x\s*:/.test(css), false);
  assert.equal(css.includes("button.answer-file,") || css.includes("button.answer-file {"), false);
  assert.equal(css.includes("text-decoration-style: dotted") || css.includes("border-bottom: 1px dotted"), false);
});
