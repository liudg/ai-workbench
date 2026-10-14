import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_DIFF_MENU_OPTIONS,
  DIFF_MENU_OPTIONS_KEY,
  readDiffMenuOptions,
  writeDiffMenuOptions,
  type DiffMenuOptions,
  type DiffMenuStorage,
} from "./diff-menu-options.ts";

function memory(): DiffMenuStorage & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (key) => raw.get(key) ?? null,
    setItem: (key, value) => {
      raw.set(key, value);
    },
  };
}

test("missing or broken storage keeps the diff menu defaults", () => {
  assert.deepEqual(readDiffMenuOptions(null), DEFAULT_DIFF_MENU_OPTIONS);
  const empty = memory();
  assert.deepEqual(readDiffMenuOptions(empty), DEFAULT_DIFF_MENU_OPTIONS);
  const broken = memory();
  broken.raw.set(DIFF_MENU_OPTIONS_KEY, "{");
  assert.deepEqual(readDiffMenuOptions(broken), DEFAULT_DIFF_MENU_OPTIONS);
});

test("diff menu toggles round-trip and ignore unknown keys", () => {
  const storage = memory();
  const saved: DiffMenuOptions = {
    loadFull: true,
    renderPreview: true,
    wordDiff: false,
    hideWhitespace: true,
    hideImports: true,
  };
  writeDiffMenuOptions(saved, storage);
  assert.deepEqual(readDiffMenuOptions(storage), saved);

  storage.raw.set(
    DIFF_MENU_OPTIONS_KEY,
    JSON.stringify({ loadFull: true, extra: "nope", wordDiff: "yes" }),
  );
  assert.deepEqual(readDiffMenuOptions(storage), {
    ...DEFAULT_DIFF_MENU_OPTIONS,
    loadFull: true,
  });
  writeDiffMenuOptions(saved, null);
});
