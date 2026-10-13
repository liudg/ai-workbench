import assert from "node:assert/strict";
import { test } from "node:test";

import { highlightParts, moveSearchCursor } from "./file-search.ts";

test("search highlights every case-insensitive match", () => {
  assert.deepEqual(highlightParts("Logs/ and log", "log"), [
    { text: "Log", hit: true },
    { text: "s/ and ", hit: false },
    { text: "log", hit: true },
  ]);
  assert.deepEqual(highlightParts("nothing", "log"), [{ text: "nothing", hit: false }]);
  assert.deepEqual(highlightParts("log", "  "), [{ text: "log", hit: false }]);
});

test("search cursor moves with the arrow keys and stays inside the list", () => {
  assert.equal(moveSearchCursor(0, 3, "ArrowDown"), 1);
  assert.equal(moveSearchCursor(2, 3, "ArrowDown"), 2);
  assert.equal(moveSearchCursor(2, 3, "ArrowUp"), 1);
  assert.equal(moveSearchCursor(0, 3, "ArrowUp"), 0);
  assert.equal(moveSearchCursor(4, 0, "ArrowDown"), 0);
});
