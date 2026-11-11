import assert from "node:assert/strict";
import { test } from "node:test";

import { isPinnedSession, sessionStatusView } from "./session-status.ts";

test("session status dots only mark running, waiting, and failed", () => {
  const running = sessionStatusView("running");
  const waiting = sessionStatusView("needs-input");
  const failed = sessionStatusView("failed");
  assert.equal(running?.word, "运行中");
  assert.equal(running?.marker, "spinner");
  assert.equal(running?.dotClass, "");
  assert.equal(running?.ringClass.includes("text-[var(--wb-muted)]"), true);
  assert.equal(/bg-|emerald|green|#22c55e/.test(`${running?.dotClass} ${running?.ringClass}`), false);
  assert.equal(running?.prominent, false);
  assert.equal(waiting?.word, "等待");
  assert.equal(waiting?.marker, "ring");
  assert.equal(waiting?.prominent, true);
  assert.equal(waiting?.dotClass.includes("bg-[var(--wb-warn-strong)]"), true);
  assert.equal(failed?.word, "失败");
  assert.equal(failed?.marker, "dot");
  assert.equal(failed?.dotClass.includes("bg-[var(--wb-danger-strong)]"), true);
  assert.equal(sessionStatusView("completed"), null);
  assert.equal(sessionStatusView("stopped"), null);
});

test("a missing status has no dot", () => {
  assert.equal(sessionStatusView(null), null);
  assert.equal(sessionStatusView(undefined), null);
  assert.equal(sessionStatusView(""), null);
  assert.equal(sessionStatusView("unknown"), null);
});

test("only running and waiting sessions pin", () => {
  assert.equal(isPinnedSession("running"), true);
  assert.equal(isPinnedSession("needs-input"), true);
  assert.equal(isPinnedSession("completed"), false);
  assert.equal(isPinnedSession("failed"), false);
  assert.equal(isPinnedSession("stopped"), false);
  assert.equal(isPinnedSession(null), false);
  assert.equal(isPinnedSession(undefined), false);
});
