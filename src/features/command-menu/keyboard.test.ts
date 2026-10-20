import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deleteShortcutMenu,
  isArchiveChord,
  isDeleteChord,
  isNewThreadChord,
  isOpenChord,
  isQuickOpenChord,
  isSidebarChord,
  jumpSection,
  moveCursor,
  sectionStarts,
} from "./keyboard.ts";

const chord = {
  key: "k",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
};

test("open chords are Ctrl/Cmd+K and Ctrl/Cmd+Shift+P", () => {
  assert.equal(isOpenChord({ ...chord, ctrlKey: true, key: "k" }), true);
  assert.equal(isOpenChord({ ...chord, metaKey: true, key: "K" }), true);
  assert.equal(isOpenChord({ ...chord, ctrlKey: true, shiftKey: true, key: "p" }), true);
  assert.equal(isOpenChord({ ...chord, ctrlKey: true, shiftKey: true, key: "k" }), false);
  assert.equal(isOpenChord({ ...chord, key: "k" }), false);
  assert.equal(isOpenChord({ ...chord, ctrlKey: true, altKey: true, key: "k" }), false);
});

test("sidebar and quick open use Ctrl or Cmd without Shift", () => {
  assert.equal(isSidebarChord({ ...chord, ctrlKey: true, key: "b" }), true);
  assert.equal(isSidebarChord({ ...chord, metaKey: true, key: "B" }), true);
  assert.equal(isQuickOpenChord({ ...chord, ctrlKey: true, key: "p" }), true);
  assert.equal(isQuickOpenChord({ ...chord, metaKey: true, key: "P" }), true);
  assert.equal(isSidebarChord({ ...chord, ctrlKey: true, shiftKey: true, key: "b" }), false);
  assert.equal(isQuickOpenChord({ ...chord, ctrlKey: true, shiftKey: true, key: "p" }), false);
  assert.equal(isOpenChord({ ...chord, ctrlKey: true, shiftKey: true, key: "p" }), true);
  assert.equal(isQuickOpenChord({ ...chord, ctrlKey: true, key: "f" }), false);
  assert.equal(isSidebarChord({ ...chord, key: "b" }), false);
  assert.equal(isQuickOpenChord({ ...chord, ctrlKey: true, altKey: true, key: "p" }), false);
});

test("thread chords stay on the observed modifiers", () => {
  assert.equal(isNewThreadChord({ ...chord, ctrlKey: true, shiftKey: true, key: "o" }), true);
  assert.equal(isArchiveChord({ ...chord, metaKey: true, shiftKey: true, key: "A" }), true);
  assert.equal(isDeleteChord({ ...chord, ctrlKey: true, shiftKey: true, key: "Delete" }), true);
  assert.equal(isDeleteChord({ ...chord, ctrlKey: true, shiftKey: true, key: "Backspace" }), true);
  assert.equal(isNewThreadChord({ ...chord, ctrlKey: true, key: "o" }), false);
  assert.deepEqual(deleteShortcutMenu(false), { open: true, drill: "delete" });
  assert.deepEqual(deleteShortcutMenu(true), { open: true, drill: "delete" });
});

test("arrows stop at the ends", () => {
  assert.equal(moveCursor(0, 3, "ArrowUp"), 0);
  assert.equal(moveCursor(2, 3, "ArrowDown"), 2);
  assert.equal(moveCursor(1, 3, "ArrowDown"), 2);
});

test("tab jumps to the next section and wraps", () => {
  const starts = sectionStarts(["suggested", "suggested", "settings", "thread"]);
  assert.deepEqual(starts, [0, 2, 3]);
  assert.equal(jumpSection(starts, 0, 1), 2);
  assert.equal(jumpSection(starts, 3, 1), 0);
  assert.equal(jumpSection(starts, 0, -1), 3);
});
