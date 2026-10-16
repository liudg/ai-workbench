import assert from "node:assert/strict";
import { test } from "node:test";

import {
  orderSidebarSessions,
  pinActiveSessions,
  SESSION_PREVIEW_LIMIT,
  sidebarSessionWindow,
} from "./session-order.ts";
import { visibleRange } from "./virtual-window.ts";

test("active sessions pin above idle ones and keep their own order", () => {
  const sessions = [
    { id: "a", status: "completed" },
    { id: "b", status: "running" },
    { id: "c", status: "failed" },
    { id: "d", status: "needs-input" },
    { id: "e", status: "stopped" },
    { id: "f", status: "completed" },
    { id: "g", status: null },
    { id: "h", status: "running" },
  ];
  assert.deepEqual(
    pinActiveSessions(sessions).map((item) => item.id),
    ["b", "d", "h", "a", "c", "e", "f", "g"],
  );
});

test("user pins sit above running sessions, newest pin first", () => {
  const sessions = [
    { id: "idle", status: "completed" },
    { id: "run", status: "running" },
    { id: "old", status: "completed" },
  ];
  assert.deepEqual(
    orderSidebarSessions(sessions, ["old", "idle"]).map((item) => item.id),
    ["old", "idle", "run"],
  );
  assert.deepEqual(
    orderSidebarSessions(sessions, []).map((item) => item.id),
    ["run", "idle", "old"],
  );
});

test("idle order is unchanged when nothing is running or waiting", () => {
  const sessions = [
    { id: "a", status: "completed" },
    { id: "b", status: "failed" },
    { id: "c", status: "stopped" },
  ];
  assert.deepEqual(
    pinActiveSessions(sessions).map((item) => item.id),
    ["a", "b", "c"],
  );
});

test("show more still previews eight and reveals the rest only when asked", () => {
  assert.equal(SESSION_PREVIEW_LIMIT, 8);
  const sessions = Array.from({ length: 9 }, (_, index) => ({
    id: `s${index}`,
    status: index === 8 ? "needs-input" : "completed",
  }));
  const collapsed = sidebarSessionWindow(sessions, false);
  assert.equal(collapsed.overflow, true);
  assert.equal(collapsed.visible.length, 8);
  assert.equal(collapsed.visible[0]?.id, "s8");
  assert.equal(
    collapsed.visible.some((item) => item.id === "s7"),
    false,
  );
  const eight = sidebarSessionWindow(sessions.slice(0, 8), false);
  assert.equal(eight.overflow, false);
  assert.equal(eight.visible.length, 8);
  const expanded = sidebarSessionWindow(sessions, true);
  assert.equal(expanded.overflow, true);
  assert.equal(expanded.visible.length, 9);
  assert.deepEqual(
    expanded.visible.map((item) => item.id),
    expanded.ordered.map((item) => item.id),
  );
});

test("expanding once shows every session instead of another eight", () => {
  const sessions = Array.from({ length: 25 }, (_, index) => ({
    id: `s${index}`,
    status: "completed" as const,
  }));
  const collapsed = sidebarSessionWindow(sessions, false);
  assert.equal(collapsed.visible.length, SESSION_PREVIEW_LIMIT);
  const expanded = sidebarSessionWindow(sessions, true);
  assert.equal(expanded.visible.length, sessions.length);
  assert.deepEqual(
    expanded.visible.map((item) => item.id),
    expanded.ordered.map((item) => item.id),
  );
});

test("the collapsed preview does not include rows past the show-more cut", () => {
  const sessions = Array.from({ length: 40 }, (_, index) => ({
    id: String(index),
    status: "completed" as const,
  }));
  const { visible } = sidebarSessionWindow(sessions, false);
  const range = visibleRange({
    count: visible.length,
    scrollTop: 0,
    viewport: 400,
    itemHeight: 30,
    overscan: 8,
  });
  assert.equal(visible.length, 8);
  assert.deepEqual(range, { start: 0, end: 8 });
});
