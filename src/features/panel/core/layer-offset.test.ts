import assert from "node:assert/strict";
import { test } from "node:test";

import { layerOffset } from "./layer-offset.ts";

test("dropdowns align to the start and menus align to the end", () => {
  const shared = {
    anchorLeft: 100,
    anchorRight: 180,
    anchorTop: 40,
    anchorBottom: 64,
    width: 200,
    height: 80,
    viewportWidth: 800,
    viewportHeight: 600,
  };
  assert.equal(layerOffset({ ...shared, align: "start" }).left, 100);
  assert.equal(layerOffset({ ...shared, align: "end" }).left, 8);
  assert.equal(layerOffset({ ...shared, align: "start" }).top, 70);
});

test("a layer that would fall off the bottom flips above the anchor", () => {
  const placed = layerOffset({
    anchorLeft: 20,
    anchorRight: 80,
    anchorTop: 500,
    anchorBottom: 530,
    width: 100,
    height: 120,
    viewportWidth: 800,
    viewportHeight: 600,
    align: "start",
  });
  assert.equal(placed.top, 500 - 120 - 6);
});
