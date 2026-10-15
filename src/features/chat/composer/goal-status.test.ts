import assert from "node:assert/strict";
import { test } from "node:test";

import { displayedElapsed, formatElapsed, formatTokens, goalStatusModel } from "./goal-status.ts";
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

test("goal usage matches the status bar", () => {
  assert.equal(formatTokens(12500), "12.5K");
  assert.equal(formatTokens(50000), "50K");
  assert.equal(formatTokens(63876), "63.9K");
  assert.equal(formatTokens(1010), "1.01K");
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(3), "3s");
  assert.equal(formatElapsed(120), "2m");
  assert.equal(formatElapsed(36720), "10h 12m");
  assert.equal(formatElapsed(24 * 60 * 60), "1d 0h 0m");

  assert.deepEqual(
    goalStatusModel(goal({ tokenBudget: 50000, tokensUsed: 12500, timeUsedSeconds: 90 }), false),
    {
      label: "进行中的目标",
      objective: "把测试补上",
      usage: "12.5K / 50K",
      elapsedSeconds: null,
      ticking: false,
      run: "pause",
      actionable: true,
    },
  );
  assert.deepEqual(goalStatusModel(goal({ timeUsedSeconds: 3 }), false), {
    label: "进行中的目标",
    objective: "把测试补上",
    usage: null,
    elapsedSeconds: 3,
    ticking: true,
    run: "pause",
    actionable: true,
  });
  assert.equal(goalStatusModel(goal(), false)?.usage, null);
  assert.equal(goalStatusModel(goal(), false)?.elapsedSeconds, null);
  assert.deepEqual(goalStatusModel(goal({ status: "paused", timeUsedSeconds: 120 }), false), {
    label: "已暂停的目标",
    objective: "把测试补上",
    usage: null,
    elapsedSeconds: 120,
    ticking: false,
    run: "resume",
    actionable: true,
  });
  assert.equal(goalStatusModel(goal({ status: "blocked" }), false)?.label, "受阻的目标");
  assert.equal(goalStatusModel(goal({ status: "blocked" }), false)?.run, "resume");
  assert.equal(goalStatusModel(goal({ status: "usageLimited" }), false)?.label, "已达用量上限");
  assert.deepEqual(
    goalStatusModel(goal({ status: "budgetLimited", tokenBudget: 50000, tokensUsed: 63876 }), false),
    {
      label: "未达成的目标",
      objective: "把测试补上",
      usage: "63.9K / 50K tokens",
      elapsedSeconds: null,
      ticking: false,
      run: null,
      actionable: true,
    },
  );
  assert.equal(goalStatusModel(goal({ status: "budgetLimited" }), false)?.label, "已放弃的目标");
  assert.equal(goalStatusModel(goal({ status: "budgetLimited" }), false)?.run, null);
  assert.deepEqual(
    goalStatusModel(
      goal({ status: "complete", tokenBudget: 50000, tokensUsed: 40000, timeUsedSeconds: 120 }),
      false,
    ),
    {
      label: "已达成的目标",
      objective: "把测试补上",
      usage: "40K tokens",
      elapsedSeconds: null,
      ticking: false,
      run: null,
      actionable: true,
    },
  );
  assert.equal(goalStatusModel(goal({ status: "complete", timeUsedSeconds: 120 }), false)?.elapsedSeconds, 120);
  assert.deepEqual(goalStatusModel(null, true), {
    label: "设置要持续追求的目标",
    objective: null,
    usage: null,
    elapsedSeconds: null,
    ticking: false,
    run: null,
    actionable: false,
  });
  assert.equal(goalStatusModel(null, false), null);
});

test("the timer advances only while the goal is running", () => {
  assert.equal(displayedElapsed(3, true, 1_000, 1_000), 3);
  assert.equal(displayedElapsed(3, true, 1_000, 3_200), 5);
  assert.equal(displayedElapsed(3, false, 1_000, 9_000), 3);
  assert.equal(displayedElapsed(3.9, true, 5_000, 4_000), 3);
});
