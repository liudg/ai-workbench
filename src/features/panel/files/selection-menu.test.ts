import assert from "node:assert/strict";
import { test } from "node:test";

import { selectionMenuUpdate } from "./selection-menu.ts";

test("the selection menu waits until mouseup", () => {
  const down = selectionMenuUpdate("down", false, true);
  assert.deepEqual(down, { dragging: true, update: "clear" });
  assert.deepEqual(selectionMenuUpdate("change", down.dragging), {
    dragging: true,
    update: "clear",
  });
  assert.deepEqual(selectionMenuUpdate("up", true), { dragging: false, update: "read" });
  assert.deepEqual(selectionMenuUpdate("change", false), { dragging: false, update: "read" });
  assert.deepEqual(selectionMenuUpdate("up", false), { dragging: false, update: "ignore" });
});

test("a press outside the preview dismisses and does not arm mouseup", () => {
  assert.deepEqual(selectionMenuUpdate("down", false, false), {
    dragging: false,
    update: "clear",
  });
  assert.deepEqual(selectionMenuUpdate("up", false), { dragging: false, update: "ignore" });
  assert.deepEqual(selectionMenuUpdate("cancel", true), { dragging: false, update: "clear" });
});
