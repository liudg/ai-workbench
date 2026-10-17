import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PINNED_PROJECTS_KEY,
  readPinnedProjectIds,
  togglePinnedProjectId,
  writePinnedProjectIds,
  type PinStorage,
} from "./pinned-projects.ts";

function memory(): PinStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

test("project pin ids round-trip and ignore junk", () => {
  const storage = memory();
  assert.deepEqual(readPinnedProjectIds(storage), []);
  writePinnedProjectIds(["p1", "p2"], storage);
  assert.equal(storage.data.get(PINNED_PROJECTS_KEY)?.includes("p1"), true);
  assert.deepEqual(readPinnedProjectIds(storage), ["p1", "p2"]);
  storage.setItem(PINNED_PROJECTS_KEY, "{\"nope\":true}");
  assert.deepEqual(readPinnedProjectIds(storage), []);
  storage.setItem(PINNED_PROJECTS_KEY, "[1, \"\", \"ok\"]");
  assert.deepEqual(readPinnedProjectIds(storage), ["ok"]);
});

test("toggle appends a project pin and removes it on the second call", () => {
  assert.deepEqual(togglePinnedProjectId(["b"], "a"), ["b", "a"]);
  assert.deepEqual(togglePinnedProjectId(["a", "b"], "a"), ["b"]);
  assert.deepEqual(togglePinnedProjectId(["a"], ""), ["a"]);
});

test("a missing storage reads empty project pins and does not throw on write", () => {
  assert.deepEqual(readPinnedProjectIds(null), []);
  writePinnedProjectIds(["a"], null);
});
