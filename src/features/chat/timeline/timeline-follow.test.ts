import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compensatedScrollTop,
  distanceFromBottom,
  historyScrollTop,
  nearBottom,
  shouldApplyHistory,
} from "./timeline-follow.ts";

test("history prepend keeps the same row in view", () => {
  assert.equal(historyScrollTop({ beforeHeight: 400, beforeTop: 12, nextHeight: 900 }), 512);
  assert.equal(historyScrollTop({ beforeHeight: 900, beforeTop: 12, nextHeight: 900 }), 12);
});

test("a history page from an older session is ignored", () => {
  assert.equal(shouldApplyHistory({ epoch: 2, currentEpoch: 2 }), true);
  assert.equal(shouldApplyHistory({ epoch: 2, currentEpoch: 3 }), false);
});

test("follow stays on only while the viewport is near the bottom", () => {
  assert.equal(nearBottom(distanceFromBottom(1000, 900, 80)), true);
  assert.equal(nearBottom(distanceFromBottom(1000, 400, 80)), false);
});

test("opening keeps distance zero instead of pinning every layout from the top", () => {
  assert.equal(
    compensatedScrollTop({
      beforeTop: 0,
      nextHeight: 50 * 280,
      clientHeight: 800,
      follow: true,
      aboveDelta: 0,
    }),
    50 * 280 - 800,
  );
});

test("a height change away from the bottom preserves distance and does not jump to the bottom", () => {
  const beforeTop = 1000;
  const clientHeight = 800;
  const beforeHeight = 5000;
  const nextHeight = 5500;
  const stayed = compensatedScrollTop({
    beforeTop,
    nextHeight,
    clientHeight,
    follow: false,
    aboveDelta: nextHeight - beforeHeight,
  });
  assert.equal(stayed, beforeTop + (nextHeight - beforeHeight));
  assert.equal(distanceFromBottom(nextHeight, stayed ?? 0, clientHeight), distanceFromBottom(beforeHeight, beforeTop, clientHeight));
  assert.notEqual(stayed, nextHeight - clientHeight);
  assert.equal(
    compensatedScrollTop({
      beforeTop,
      nextHeight,
      clientHeight,
      follow: false,
      aboveDelta: 0,
    }),
    null,
  );
});

test("prepend compensation matches the history row restore", () => {
  assert.equal(
    compensatedScrollTop({
      beforeTop: 12,
      nextHeight: 900,
      clientHeight: 80,
      follow: false,
      aboveDelta: 500,
    }),
    historyScrollTop({ beforeHeight: 400, beforeTop: 12, nextHeight: 900 }),
  );
});

test("history restore keeps a bottom-anchored thread near the bottom", () => {
  const stayed = historyScrollTop({ beforeHeight: 100, beforeTop: 0, nextHeight: 800 });
  assert.equal(distanceFromBottom(800, stayed, 80), distanceFromBottom(100, 0, 80));
  assert.equal(nearBottom(distanceFromBottom(800, stayed, 80)), true);
  const away = historyScrollTop({ beforeHeight: 2000, beforeTop: 10, nextHeight: 2500 });
  assert.equal(nearBottom(distanceFromBottom(2500, away, 80)), false);
});
