import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PINNED_SESSIONS_KEY,
  readPinnedSessionIds,
  togglePinnedSessionId,
  writePinnedSessionIds,
  type PinStorage,
} from "./pinned-sessions.ts";

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

test("pin ids round-trip and ignore junk", () => {
  const storage = memory();
  assert.deepEqual(readPinnedSessionIds(storage), []);
  writePinnedSessionIds(["codex-cli:a", "claude-code:b"], storage);
  assert.equal(storage.data.get(PINNED_SESSIONS_KEY)?.includes("codex-cli:a"), true);
  assert.deepEqual(readPinnedSessionIds(storage), ["codex-cli:a", "claude-code:b"]);
  storage.setItem(PINNED_SESSIONS_KEY, "{\"nope\":true}");
  assert.deepEqual(readPinnedSessionIds(storage), []);
  storage.setItem(PINNED_SESSIONS_KEY, "[1, \"\", \"ok\"]");
  assert.deepEqual(readPinnedSessionIds(storage), ["ok"]);
});

test("toggle prepends a pin and removes it on the second call", () => {
  assert.deepEqual(togglePinnedSessionId(["b"], "a"), ["a", "b"]);
  assert.deepEqual(togglePinnedSessionId(["a", "b"], "a"), ["b"]);
  assert.deepEqual(togglePinnedSessionId(["a"], ""), ["a"]);
});

test("a missing storage reads empty and does not throw on write", () => {
  assert.deepEqual(readPinnedSessionIds(null), []);
  writePinnedSessionIds(["a"], null);
});
