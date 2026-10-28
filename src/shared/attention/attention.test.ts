import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attentionPill,
  attentionQueue,
  boardColumn,
  nextInQueue,
  strongestPill,
  type Attention,
} from "./attention.ts";

const at = (state: Attention["state"], extra: Partial<Attention> = {}): Attention => ({
  state,
  unread: false,
  updatedAt: 0,
  ...extra,
});

test("pills only color what needs you; working is a gray pulse", () => {
  assert.equal(attentionPill(at("needs-input", { ask: "approval" }))?.label, "待批准");
  assert.equal(attentionPill(at("needs-input", { ask: "input" }))?.label, "待回答");
  assert.equal(attentionPill(at("needs-input"))?.label, "待回答");
  const working = attentionPill(at("working"));
  assert.equal(working?.pulse, true);
  assert.equal(/emerald|green|red|f0a04a/.test(`${working?.textClass} ${working?.dotClass}`), false);
  assert.equal(attentionPill(at("done", { unread: true }))?.label, "已完成");
  assert.equal(attentionPill(at("failed", { unread: true }))?.label, "失败");
  assert.equal(attentionPill(at("done")), null);
  assert.equal(attentionPill(at("failed")), null);
  assert.equal(attentionPill(at("idle")), null);
  assert.equal(attentionPill(undefined), null);
});

test("project row shows the most urgent pill", () => {
  assert.equal(strongestPill([at("working"), at("done", { unread: true })])?.label, "已完成");
  assert.equal(
    strongestPill([at("needs-input", { ask: "input" }), at("needs-input", { ask: "approval" })])?.label,
    "待批准",
  );
  assert.equal(strongestPill([at("idle"), at("done")]), null);
});

test("board columns follow orca: seen results drop to idle", () => {
  assert.equal(boardColumn(at("needs-input")), "needs-you");
  assert.equal(boardColumn(at("failed", { unread: true })), "needs-you");
  assert.equal(boardColumn(at("failed")), "idle");
  assert.equal(boardColumn(at("working")), "working");
  assert.equal(boardColumn(at("done", { unread: true })), "done");
  assert.equal(boardColumn(at("done")), "idle");
  assert.equal(boardColumn(at("idle")), "idle");
});

test("queue puts the most urgent first, then the longest waiting", () => {
  const items = [
    { id: "done-old", attention: at("done", { unread: true, updatedAt: 1 }) },
    { id: "seen", attention: at("done", { updatedAt: 0 }) },
    { id: "working", attention: at("working") },
    { id: "ask-new", attention: at("needs-input", { ask: "input", updatedAt: 9 }) },
    { id: "ask-old", attention: at("needs-input", { ask: "input", updatedAt: 3 }) },
    { id: "approve", attention: at("needs-input", { ask: "approval", updatedAt: 10 }) },
  ];
  const queue = attentionQueue(items);
  assert.deepEqual(
    queue.map((item) => item.id),
    ["approve", "ask-old", "ask-new", "done-old"],
  );
  assert.equal(nextInQueue(queue, null)?.id, "approve");
  assert.equal(nextInQueue(queue, "seen")?.id, "approve");
  assert.equal(nextInQueue(queue, "ask-new")?.id, "done-old");
  assert.equal(nextInQueue(queue, "done-old")?.id, "approve");
  assert.equal(nextInQueue(queue.slice(0, 1), "approve"), null);
  assert.equal(nextInQueue([], null), null);
});
