import assert from "node:assert/strict";
import { test } from "node:test";

import { formatElapsed, formatTokens, goalStatusLine } from "./goal-status.ts";
import type { GoalSnapshot } from "./goal.ts";

function goal(patch: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    objective: "把测试补上",
    status: "active",
    tokenBudget: null,
    tokensUsed: null,
    timeUsedSeconds: null,
    ...patch,
  };
}

test("goal usage matches the TUI status line", () => {
  assert.equal(formatTokens(12500), "12.5K");
  assert.equal(formatTokens(50000), "50K");
  assert.equal(formatTokens(63876), "63.9K");
  assert.equal(formatTokens(1010), "1.01K");
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(120), "2m");
  assert.equal(formatElapsed(36720), "10h 12m");
  assert.equal(formatElapsed(24 * 60 * 60), "1d 0h 0m");
  assert.equal(
    goalStatusLine(goal({ tokenBudget: 50000, tokensUsed: 12500, timeUsedSeconds: 90 }), false),
    "正在追求目标 (12.5K / 50K)",
  );
  assert.equal(goalStatusLine(goal({ timeUsedSeconds: 120 }), false), "正在追求目标 (2m)");
  assert.equal(goalStatusLine(goal(), false), "正在追求目标");
  assert.equal(goalStatusLine(goal({ status: "paused", timeUsedSeconds: 120 }), false), "目标已暂停（/goal resume）");
  assert.equal(goalStatusLine(goal({ status: "blocked" }), false), "目标已受阻（/goal resume）");
  assert.equal(
    goalStatusLine(goal({ status: "budgetLimited", tokenBudget: 50000, tokensUsed: 63876 }), false),
    "目标未达成 (63.9K / 50K tokens)",
  );
  assert.equal(goalStatusLine(goal({ status: "budgetLimited" }), false), "目标已放弃");
  assert.equal(
    goalStatusLine(goal({ status: "complete", tokenBudget: 50000, tokensUsed: 40000, timeUsedSeconds: 120 }), false),
    "目标已达成 (40K tokens)",
  );
  assert.equal(goalStatusLine(null, true), "设置要持续追求的目标");
  assert.equal(goalStatusLine(null, false), null);
});
