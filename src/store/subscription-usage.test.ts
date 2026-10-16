import assert from "node:assert/strict";
import { test } from "node:test";

import type { SubscriptionWindow } from "../types/index.ts";
import {
  formatSubscriptionHeadline,
  parseSubscriptionSeed,
  pickTightestWindow,
  remainingPercent,
  shouldRefreshAfterStatus,
  subscriptionTone,
} from "./subscription-usage.ts";

function window(patch: Partial<SubscriptionWindow> & Pick<SubscriptionWindow, "id">): SubscriptionWindow {
  return { label: patch.id, ...patch };
}

test("remaining prefers an explicit remainder over used percent", () => {
  assert.equal(remainingPercent(window({ id: "a", used_percent: 10, remaining_percent: 40 })), 40);
  assert.equal(remainingPercent(window({ id: "b", used_percent: 11 })), 89);
  assert.equal(remainingPercent(window({ id: "c" })), null);
});

test("the tightest window is the lowest remainder, then the earlier reset", () => {
  const weekly = window({ id: "week", used_percent: 80, resets_at_ms: 5_000 });
  const hourly = window({ id: "hour", remaining_percent: 40, resets_at_ms: 9_000 });
  const sooner = window({ id: "soon", remaining_percent: 40, resets_at_ms: 1_000 });
  assert.equal(pickTightestWindow([hourly, weekly, sooner])?.id, "week");
  assert.equal(pickTightestWindow([hourly, sooner])?.id, "soon");
  assert.equal(pickTightestWindow([window({ id: "blank" })]), null);
});

test("headline shows the wait, an imminent reset, or percent only", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    formatSubscriptionHeadline(window({ id: "w", used_percent: 11, resets_at_ms: now + 7_980_000 }), now),
    "剩 89% · 2h13m 后重置",
  );
  assert.equal(
    formatSubscriptionHeadline(window({ id: "d", remaining_percent: 50, resets_at_ms: now + 93_600_000 }), now),
    "剩 50% · 1d2h 后重置",
  );
  assert.equal(
    formatSubscriptionHeadline(window({ id: "m", remaining_percent: 70, resets_at_ms: now + 125_000 }), now),
    "剩 70% · 2m 后重置",
  );
  assert.equal(
    formatSubscriptionHeadline(window({ id: "s", remaining_percent: 70, resets_at_ms: now + 4_000 }), now),
    "剩 70% · 4s 后重置",
  );
  assert.equal(
    formatSubscriptionHeadline(window({ id: "due", remaining_percent: 3, resets_at_ms: now }), now),
    "剩 3% · 即将重置",
  );
  assert.equal(formatSubscriptionHeadline(window({ id: "open", used_percent: 25 }), now), "剩 75%");
});

test("low remainder is a warning, and five percent or less is critical", () => {
  assert.equal(subscriptionTone(21), "normal");
  assert.equal(subscriptionTone(20), "warning");
  assert.equal(subscriptionTone(5), "critical");
  assert.equal(subscriptionTone(5.4), "critical");
  assert.equal(subscriptionTone(5.5), "warning");
});

test("a turn refresh happens only when running ends in a terminal status", () => {
  assert.equal(shouldRefreshAfterStatus("running", "completed"), true);
  assert.equal(shouldRefreshAfterStatus("running", "failed"), true);
  assert.equal(shouldRefreshAfterStatus("running", "stopped"), true);
  assert.equal(shouldRefreshAfterStatus("running", "needs-input"), false);
  assert.equal(shouldRefreshAfterStatus("needs-input", "completed"), false);
  assert.equal(shouldRefreshAfterStatus("completed", "running"), false);
  assert.equal(shouldRefreshAfterStatus(undefined, "completed"), false);
});

test("preview seed parses windows without storing a live account snapshot", () => {
  const usage = parseSubscriptionSeed("每周:used:37:1800000000,5小时:remaining:12");
  assert.deepEqual(usage, {
    windows: [
      { id: "每周", label: "每周", used_percent: 37, resets_at_ms: 1_800_000_000_000 },
      { id: "5小时", label: "5小时", remaining_percent: 12 },
    ],
  });
  assert.equal(parseSubscriptionSeed("bad"), null);
});
