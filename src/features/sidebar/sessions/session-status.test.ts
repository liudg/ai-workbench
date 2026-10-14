import assert from "node:assert/strict";
import { test } from "node:test";

import { isPinnedSession, sessionStatusView } from "./session-status.ts";

test("session status uses the existing tone for each known state", () => {
  const running = sessionStatusView("running");
  const waiting = sessionStatusView("needs-input");
  const ready = sessionStatusView("completed");
  const failed = sessionStatusView("failed");
  const stopped = sessionStatusView("stopped");
  assert.equal(running?.word, "运行中");
  assert.equal(running?.className.includes("bg-sky-400"), true);
  assert.equal(running?.prominent, false);
  assert.equal(waiting?.word, "等待");
  assert.equal(waiting?.prominent, true);
  assert.equal(waiting?.className.includes("bg-amber-400"), true);
  assert.equal(waiting?.className.includes("ring-"), true);
  assert.equal(ready?.word, "就绪");
  assert.equal(ready?.className.includes("bg-emerald-400"), true);
  assert.equal(failed?.word, "失败");
  assert.equal(failed?.className.includes("bg-red-400"), true);
  assert.equal(stopped?.word, "已停止");
  assert.equal(stopped?.className.includes("bg-zinc-500"), true);
  for (const view of [running, waiting, ready, failed, stopped]) {
    assert.equal(view?.className.includes("border"), false);
  }
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
