import assert from "node:assert/strict";
import { test } from "node:test";

import { selectionMenuPoint, selectionMenuPosition, selectionMenuUpdate } from "./selection-menu.ts";

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

test("a press outside the selection root dismisses and does not arm mouseup", () => {
  assert.deepEqual(selectionMenuUpdate("down", false, false), {
    dragging: false,
    update: "clear",
  });
  assert.deepEqual(selectionMenuUpdate("up", false), { dragging: false, update: "ignore" });
  assert.deepEqual(selectionMenuUpdate("cancel", true), { dragging: false, update: "clear" });
});

test("mouseup coordinates win over the selection end", () => {
  assert.deepEqual(selectionMenuPoint({ x: 12, y: 40 }, { x: 200, y: 80 }), { x: 12, y: 40 });
  assert.deepEqual(selectionMenuPoint(null, { x: 200, y: 80 }), { x: 200, y: 80 });
  assert.equal(selectionMenuPoint(null, null), null);
});

test("the menu's top-left sits on the mouseup point", () => {
  assert.deepEqual(
    selectionMenuPosition({ x: 320, y: 240 }, { width: 800, height: 600 }, { width: 112, height: 32 }),
    { top: 240, left: 320 },
  );
});

test("a menu that would leave the bottom flips above the mouseup point", () => {
  assert.deepEqual(
    selectionMenuPosition({ x: 320, y: 590 }, { width: 800, height: 600 }, { width: 112, height: 32 }),
    { top: 558, left: 320 },
  );
});

test("a menu that would leave the right edge shifts left", () => {
  assert.deepEqual(
    selectionMenuPosition({ x: 790, y: 240 }, { width: 800, height: 600 }, { width: 112, height: 32 }),
    { top: 240, left: 680 },
  );
});

test("a mouseup in the corner stays inside the viewport", () => {
  const placed = selectionMenuPosition(
    { x: 2, y: 590 },
    { width: 800, height: 600 },
    { width: 112, height: 32 },
  );
  assert.equal(placed.left, 8);
  assert.equal(placed.top, 558);
  assert.ok(placed.left + 112 <= 800 - 8);
  assert.ok(placed.top + 32 <= 600 - 8);
});

test("a menu wider than the viewport is clamped to the margins", () => {
  const placed = selectionMenuPosition(
    { x: 20, y: 20 },
    { width: 320, height: 240 },
    { width: 900, height: 400 },
  );
  assert.equal(placed.left, 8);
  assert.equal(placed.top, 8);
  assert.ok(placed.left <= 320 - 8);
  assert.ok(placed.top <= 240 - 8);
});
