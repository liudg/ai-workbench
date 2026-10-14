import assert from "node:assert/strict";
import { test } from "node:test";

import { clampRange, SESSION_ROW_HEIGHT, visibleRange } from "./virtual-window.ts";

test("visible range stays inside the list and above a full render", () => {
  const top = visibleRange({
    count: 400,
    scrollTop: 0,
    viewport: 280,
    itemHeight: SESSION_ROW_HEIGHT,
    overscan: 8,
  });
  assert.equal(top.start, 0);
  assert.ok(top.end < 40);
  assert.ok(top.end > 8);

  const mid = visibleRange({
    count: 400,
    scrollTop: SESSION_ROW_HEIGHT * 200,
    viewport: 280,
    itemHeight: SESSION_ROW_HEIGHT,
    overscan: 8,
  });
  assert.ok(mid.start > 180);
  assert.ok(mid.end < 230);
  assert.ok(mid.end - mid.start < 40);
});

test("a row that ends on the viewport edge is included and the next is not", () => {
  const range = visibleRange({
    count: 10,
    scrollTop: 0,
    viewport: 60,
    itemHeight: 30,
    overscan: 0,
  });
  assert.deepEqual(range, { start: 0, end: 2 });
});

test("rows above and below the viewport are not required", () => {
  const below = visibleRange({
    count: 50,
    scrollTop: -400,
    viewport: 120,
    itemHeight: 30,
    overscan: 0,
  });
  assert.deepEqual(below, { start: 0, end: 0 });

  const above = visibleRange({
    count: 10,
    scrollTop: 10_000,
    viewport: 120,
    itemHeight: 30,
    overscan: 4,
  });
  assert.deepEqual(above, { start: 10, end: 10 });
});

test("empty and unmeasured viewports render nothing", () => {
  assert.deepEqual(
    visibleRange({ count: 0, scrollTop: 0, viewport: 400, itemHeight: 30, overscan: 8 }),
    { start: 0, end: 0 },
  );
  assert.deepEqual(
    visibleRange({ count: 20, scrollTop: 0, viewport: 0, itemHeight: 30, overscan: 8 }),
    { start: 0, end: 0 },
  );
  assert.deepEqual(
    visibleRange({ count: 20, scrollTop: 0, viewport: 400, itemHeight: 0, overscan: 8 }),
    { start: 0, end: 0 },
  );
  assert.deepEqual(
    visibleRange({
      count: 20,
      scrollTop: Number.NaN,
      viewport: 400,
      itemHeight: 30,
      overscan: 8,
    }),
    { start: 0, end: 0 },
  );
});

test("overscan does not walk off either end", () => {
  const range = visibleRange({
    count: 5,
    scrollTop: 0,
    viewport: 30,
    itemHeight: 30,
    overscan: 8,
  });
  assert.deepEqual(range, { start: 0, end: 5 });
});

test("a stale window falls back inside the new list", () => {
  assert.deepEqual(clampRange({ start: 40, end: 60 }, 8), { start: 0, end: 8 });
  assert.deepEqual(clampRange({ start: 2, end: 6 }, 8), { start: 2, end: 6 });
  assert.deepEqual(clampRange({ start: 0, end: 0 }, 0), { start: 0, end: 0 });
  assert.deepEqual(clampRange({ start: 0, end: 0 }, 12), { start: 0, end: 0 });
  assert.deepEqual(clampRange({ start: 12, end: 12 }, 12), { start: 12, end: 12 });
});
