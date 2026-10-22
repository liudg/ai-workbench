import assert from "node:assert/strict";
import { test } from "node:test";

import { keysEnteringAfterTail } from "./history-enter.ts";
import {
  aboveViewportDelta,
  distanceAfterHeightChange,
  TURN_ESTIMATE_PX,
  TURN_OVERSCAN,
  turnWindow,
} from "./turn-virtualizer.ts";

const VIEWPORT = 800;

function uniform(count: number, height = TURN_ESTIMATE_PX): number[] {
  return Array.from({ length: count }, () => height);
}

test("opening a long thread mounts the tail, not the head", () => {
  const count = 50;
  const heights = uniform(count);
  const span = turnWindow({
    count,
    distanceFromBottom: 0,
    viewport: VIEWPORT,
    heights,
  });
  const visible = Math.ceil(VIEWPORT / TURN_ESTIMATE_PX);
  assert.equal(span.totalHeight, count * TURN_ESTIMATE_PX);
  assert.equal(span.end, count);
  assert.equal(span.start, count - visible - TURN_OVERSCAN);
  assert.ok(span.end - span.start <= visible + TURN_OVERSCAN);
  assert.ok(span.start > 0);
  assert.equal(span.prefix[span.start], span.start * TURN_ESTIMATE_PX);
  assert.equal(span.prefix[0], 0);
  assert.equal(span.prefix[count], span.totalHeight);
  const topSpacer = span.prefix[span.start] ?? 0;
  const bottomSpacer = span.totalHeight - (span.prefix[span.end] ?? 0);
  const shown = (span.prefix[span.end] ?? 0) - topSpacer;
  assert.equal(topSpacer + shown + bottomSpacer, span.totalHeight);
});

test("scrolling up reveals earlier turns and keeps the tail out of the window", () => {
  const heights = uniform(50);
  const total = 50 * TURN_ESTIMATE_PX;
  const span = turnWindow({
    count: 50,
    distanceFromBottom: total - VIEWPORT,
    viewport: VIEWPORT,
    heights,
  });
  assert.equal(span.start, 0);
  assert.equal(span.end, Math.ceil(VIEWPORT / TURN_ESTIMATE_PX) + TURN_OVERSCAN);
  assert.ok(span.end < 50);
});

test("overscan stays inside the list when the thread is shorter than the viewport", () => {
  const span = turnWindow({
    count: 3,
    distanceFromBottom: 0,
    viewport: VIEWPORT,
    heights: uniform(3),
  });
  assert.deepEqual({ start: span.start, end: span.end }, { start: 0, end: 3 });
});

test("an unmeasured viewport anchors to the tail instead of the head", () => {
  const span = turnWindow({
    count: 40,
    distanceFromBottom: 0,
    viewport: 0,
    heights: uniform(40),
  });
  assert.equal(span.end, 40);
  assert.equal(span.start, 40 - TURN_OVERSCAN);
  assert.deepEqual(
    turnWindow({ count: 0, distanceFromBottom: 0, viewport: VIEWPORT, heights: [] }),
    { start: 0, end: 0, totalHeight: 0, prefix: [0] },
  );
});

test("a measured tail replaces the estimate and shrinks the window", () => {
  const heights = uniform(10);
  heights[9] = 2000;
  const span = turnWindow({
    count: 10,
    distanceFromBottom: 0,
    viewport: VIEWPORT,
    heights,
  });
  assert.equal(span.totalHeight, 9 * TURN_ESTIMATE_PX + 2000);
  assert.equal(span.end, 10);
  assert.equal(span.start, 10 - 1 - TURN_OVERSCAN);
});

test("prepend and a taller row above the viewport shift scroll, an append does not", () => {
  const before = [
    { key: "a", height: 100 },
    { key: "b", height: 100 },
    { key: "c", height: 100 },
  ];
  assert.equal(
    aboveViewportDelta({
      before,
      after: [
        { key: "x", height: 280 },
        { key: "y", height: 280 },
        ...before,
      ],
      scrollTop: 0,
    }),
    560,
  );
  assert.equal(
    aboveViewportDelta({
      before,
      after: [
        { key: "a", height: 180 },
        { key: "b", height: 100 },
        { key: "c", height: 100 },
      ],
      scrollTop: 150,
    }),
    80,
  );
  assert.equal(
    aboveViewportDelta({
      before,
      after: [...before, { key: "d", height: 280 }],
      scrollTop: 0,
    }),
    0,
  );
  assert.equal(aboveViewportDelta({ before: [], after: before, scrollTop: 0 }), 0);
});

test("distance stays put when growth is above the viewport and grows when the tail does", () => {
  assert.equal(
    distanceAfterHeightChange({
      beforeDistance: 3200,
      beforeTotal: 5000,
      afterTotal: 5600,
      aboveDelta: 600,
      follow: false,
    }),
    3200,
  );
  assert.equal(
    distanceAfterHeightChange({
      beforeDistance: 3200,
      beforeTotal: 5000,
      afterTotal: 5600,
      aboveDelta: 0,
      follow: false,
    }),
    3800,
  );
  assert.equal(
    distanceAfterHeightChange({
      beforeDistance: 3200,
      beforeTotal: 5000,
      afterTotal: 5600,
      aboveDelta: 600,
      follow: true,
    }),
    0,
  );
});

test("history on the first paint does not enter, and only a new tail does", () => {
  assert.equal(keysEnteringAfterTail(["a", "b", "c"], null, false).size, 0);
  assert.deepEqual([...keysEnteringAfterTail(["a", "b"], null, true)], ["a", "b"]);
  assert.deepEqual([...keysEnteringAfterTail(["a", "b", "c"], "b", true)], ["c"]);
  assert.equal(keysEnteringAfterTail(["x", "a", "b"], "b", true).size, 0);
  assert.equal(keysEnteringAfterTail(["a", "b", "c"], "missing", true).size, 0);
});
