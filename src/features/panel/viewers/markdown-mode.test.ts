import assert from "node:assert/strict";
import { test } from "node:test";

import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import {
  markdownModeButtonLabel,
  markdownViewMode,
  nextMarkdownViewMode,
  rememberMarkdownViewMode,
  resetMarkdownViewModes,
} from "./markdown-mode.ts";

test("markdown opens in preview and the button offers source", () => {
  resetMarkdownViewModes();
  assert.equal(markdownViewMode("notes/宝石.md"), "preview");
  assert.equal(markdownModeButtonLabel("preview"), DESKTOP_ZH.markdownViewSource);
  assert.equal(DESKTOP_ZH.markdownViewSource, "查看源代码");
});

test("switching remembers the mode for that file only", () => {
  resetMarkdownViewModes();
  rememberMarkdownViewMode("notes/宝石.md", nextMarkdownViewMode("preview"));
  assert.equal(markdownViewMode("notes/宝石.md"), "source");
  assert.equal(markdownModeButtonLabel("source"), "查看预览");
  assert.equal(markdownViewMode("notes/其他.md"), "preview");
  rememberMarkdownViewMode("notes/宝石.md", nextMarkdownViewMode("source"));
  assert.equal(markdownViewMode("notes/宝石.md"), "preview");
});
