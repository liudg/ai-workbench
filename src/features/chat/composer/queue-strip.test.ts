import assert from "node:assert/strict";
import { test } from "node:test";

import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import {
  clampQueueIndex,
  focusedQueueItem,
  nextQueueIndex,
  queueMenuItems,
  queuePreviewText,
  queueStripIntent,
  queueStripVisible,
} from "./queue-strip.ts";

const items = [
  { id: "a", text: "先改提示" },
  { id: "b", text: "再补测试" },
];

test("queue menu ships edit and close, and omits side chat", () => {
  assert.equal(DESKTOP_ZH.queueSteer, "引导");
  assert.deepEqual(
    queueMenuItems(false).map((item) => item.label),
    ["编辑消息", "关闭排队"],
  );
  assert.equal(
    queueMenuItems(false).some((item) => item.id === "side-chat"),
    false,
  );
  assert.deepEqual(
    queueMenuItems(true).map((item) => item.id),
    ["edit", "side-chat", "close"],
  );
  assert.equal(queueMenuItems(true)[1]?.label, "在侧边聊天中打开");
});

test("steer, delete, and edit target the focused queued item", () => {
  assert.equal(focusedQueueItem(items, 0)?.id, "a");
  assert.equal(nextQueueIndex(items.length, 0), 1);
  const focused = focusedQueueItem(items, 1);
  assert.deepEqual(queueStripIntent("steer", focused), { type: "steer", id: "b" });
  assert.deepEqual(queueStripIntent("remove", focused), { type: "remove", id: "b" });
  assert.deepEqual(queueStripIntent("edit", focused), { type: "edit", id: "b" });
  assert.deepEqual(queueStripIntent("close", focused), { type: "close" });
  assert.equal(queueStripIntent("steer", null), null);
  assert.equal(queueStripIntent("edit", null), null);
  assert.deepEqual(queueStripIntent("close", null), { type: "close" });
  assert.equal(nextQueueIndex(1, 0), 0);
  assert.equal(clampQueueIndex(2, 9), 1);
  assert.equal(focusedQueueItem(items, 9)?.id, "b");
});

test("strip stays off unless the agent queues and something is waiting", () => {
  assert.equal(queueStripVisible({ supportsQueue: true, count: 1 }), true);
  assert.equal(queueStripVisible({ supportsQueue: false, count: 1 }), false);
  assert.equal(queueStripVisible({ supportsQueue: true, count: 0 }), false);
});

test("preview keeps the focused message on one line", () => {
  assert.equal(queuePreviewText({ text: "第一行\n第二行" }), "第一行 第二行");
  assert.equal(queuePreviewText({ text: "  ", images: ["C:/shot.png"] }), "shot.png");
  assert.equal(queuePreviewText({ text: "", images: ["a.png", "b.png"] }), "a.png +1");
});
