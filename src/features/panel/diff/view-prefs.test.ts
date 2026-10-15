import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_DIFF_MENU_OPTIONS } from "./diff-menu-options.ts";
import {
  defaultDiffViewPrefs,
  diffViewPrefsEqual,
  mergeDiffViewPrefs,
  modeForPaths,
  pathsForFileOpen,
} from "./view-prefs.ts";

test("merging a view toggle keeps the other remembered switches", () => {
  const current = defaultDiffViewPrefs();
  const next = mergeDiffViewPrefs(current, {
    layout: "split",
    menu: { ...current.menu, hideWhitespace: true },
  });
  assert.equal(next.layout, "split");
  assert.equal(next.wrap, true);
  assert.equal(next.filesOpen, true);
  assert.equal(next.menu.hideWhitespace, true);
  assert.equal(next.menu.wordDiff, DEFAULT_DIFF_MENU_OPTIONS.wordDiff);
  assert.equal(diffViewPrefsEqual(current, next), false);
  assert.equal(diffViewPrefsEqual(next, mergeDiffViewPrefs(next, { layout: "split" })), true);
});

test("expand-all, collapse, and custom file sets survive a new file list", () => {
  const files = ["a.ts", "b.ts", "c.ts"];
  assert.deepEqual(pathsForFileOpen("default", [], files), ["a.ts"]);
  assert.deepEqual(pathsForFileOpen("all", [], files), files);
  assert.deepEqual(pathsForFileOpen("collapsed", ["a.ts"], files), []);
  assert.deepEqual(pathsForFileOpen("custom", ["b.ts", "gone.ts"], files), ["b.ts"]);
  assert.equal(modeForPaths(files, files), "all");
  assert.equal(modeForPaths([], files), "collapsed");
  assert.equal(modeForPaths(["b.ts"], files), "custom");
});
