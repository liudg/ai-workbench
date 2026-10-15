import assert from "node:assert/strict";
import { test } from "node:test";

import { placeQuestionPopup } from "./question-popup-place.ts";

test("popup sits just above the composer and matches its width", () => {
  const placed = placeQuestionPopup(
    { left: 240, top: 640, width: 720 },
    { width: 1280, height: 800 },
    52,
  );
  assert.equal(placed.left, 240);
  assert.equal(placed.width, 720);
  assert.equal(placed.bottom, 800 - 640 + 8);
  assert.equal(placed.maxHeight, 640 - 8 - 52);
});

test("popup clamps inside the viewport", () => {
  const placed = placeQuestionPopup(
    { left: -20, top: 400, width: 900 },
    { width: 320, height: 500 },
    8,
  );
  assert.equal(placed.left, 8);
  assert.equal(placed.width, 320 - 16);
  assert.ok(placed.left + placed.width <= 320 - 8);
});

test("popup keeps a usable height when the ceiling is close", () => {
  const placed = placeQuestionPopup(
    { left: 16, top: 80, width: 400 },
    { width: 800, height: 200 },
    40,
  );
  assert.equal(placed.maxHeight, 96);
  assert.equal(placed.bottom, 200 - 80 + 8);
});
