import assert from "node:assert/strict";
import { test } from "node:test";

import {
  orderSidebarSessions,
  pinActiveSessions,
  revealMoreSessions,
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

test("show more previews eight, then one more page of eight", () => {
  assert.equal(SESSION_PREVIEW_LIMIT, 8);
  const sessions = Array.from({ length: 9 }, (_, index) => ({
    id: `s${index}`,
    status: index === 8 ? "needs-input" : "completed",
  }));
  const collapsed = sidebarSessionWindow(sessions, SESSION_PREVIEW_LIMIT);
  assert.equal(collapsed.canRevealMore, true);
  assert.equal(collapsed.canCollapse, false);
  assert.equal(collapsed.visible.length, 8);
  assert.equal(collapsed.visible[0]?.id, "s8");
  assert.equal(
    collapsed.visible.some((item) => item.id === "s7"),
    false,
  );
  const eight = sidebarSessionWindow(sessions.slice(0, 8), SESSION_PREVIEW_LIMIT);
  assert.equal(eight.canRevealMore, false);
  assert.equal(eight.visible.length, 8);
  const expanded = sidebarSessionWindow(sessions, revealMoreSessions(SESSION_PREVIEW_LIMIT));
  assert.equal(expanded.visible.length, 9);
  assert.equal(expanded.canRevealMore, false);
  assert.equal(expanded.canCollapse, true);
});

test("each expand reveals eight more and collapse returns to eight", () => {
  const sessions = Array.from({ length: 25 }, (_, index) => ({
    id: `s${index}`,
    status: "completed" as const,
  }));
  const first = sidebarSessionWindow(sessions, SESSION_PREVIEW_LIMIT);
  assert.equal(first.visible.length, 8);
  assert.equal(first.canRevealMore, true);
  const sixteen = revealMoreSessions(SESSION_PREVIEW_LIMIT);
  assert.equal(sixteen, 16);
  const second = sidebarSessionWindow(sessions, sixteen);
  assert.equal(second.visible.length, 16);
  assert.deepEqual(
    second.visible.map((item) => item.id),
    second.ordered.slice(0, 16).map((item) => item.id),
  );
  const third = sidebarSessionWindow(sessions, revealMoreSessions(sixteen));
  assert.equal(third.visible.length, 24);
  assert.equal(third.canRevealMore, true);
  const rest = sidebarSessionWindow(sessions, revealMoreSessions(24));
  assert.equal(rest.visible.length, 25);
  assert.equal(rest.canRevealMore, false);
  assert.equal(rest.canCollapse, true);
  const collapsed = sidebarSessionWindow(sessions, SESSION_PREVIEW_LIMIT);
  assert.equal(collapsed.visible.length, 8);
  assert.equal(collapsed.canCollapse, false);
});

test("the collapsed preview does not include rows past the show-more cut", () => {
  const sessions = Array.from({ length: 40 }, (_, index) => ({
    id: String(index),
    status: "completed" as const,
  }));
  const { visible } = sidebarSessionWindow(sessions, SESSION_PREVIEW_LIMIT);
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
