import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedMenuPosition } from "./fixed-menu-position.ts";

test("a menu anchored at the sidebar edge stays inside the viewport", () => {
  const placed = fixedMenuPosition({
    anchor: { left: 210, right: 234, top: 80, bottom: 104 },
    menu: { width: 240, height: 120 },
    viewport: { width: 1280, height: 800 },
    prefer: "below",
  });
  assert.equal(placed.left, 8);
  assert.equal(placed.top, 110);
  assert.ok(placed.left + Math.min(240, placed.maxWidth) <= 1280 - 8);
  assert.ok(placed.top + 120 <= 800 - 8);
  assert.equal(placed.maxWidth, 1280 - 16);
});

test("a menu wider than the viewport is clamped to the margins", () => {
  const placed = fixedMenuPosition({
    anchor: { left: 20, right: 40, top: 20, bottom: 40 },
    menu: { width: 900, height: 40 },
    viewport: { width: 320, height: 240 },
    prefer: "below",
  });
  assert.equal(placed.left, 8);
  assert.equal(placed.maxWidth, 304);
  assert.ok(placed.left + placed.maxWidth <= 320 - 8);
});

test("a menu that would fall off the bottom flips above the trigger", () => {
  const placed = fixedMenuPosition({
    anchor: { left: 40, right: 200, top: 700, bottom: 724 },
    menu: { width: 160, height: 120 },
    viewport: { width: 800, height: 760 },
    prefer: "below",
  });
  assert.equal(placed.left, 40);
  assert.equal(placed.top, 700 - 120 - 6);
});
