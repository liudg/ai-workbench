import assert from "node:assert/strict";
import { test } from "node:test";

import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import {
  queueMenuItems,
  queuePreviewText,
  queueRows,
  queueStripVisible,
} from "./queue-strip.ts";

const items = [
  { id: "a", text: "先改提示" },
  { id: "b", text: "再补测试\n第二行" },
];

test("queue menu flips the mode label and omits side chat", () => {
  assert.equal(DESKTOP_ZH.queueSteer, "引导");
  assert.equal(DESKTOP_ZH.queueSteerHint, "提交这条排队消息，不打断当前模型回合");
  assert.deepEqual(
    queueMenuItems({ canOpenSideChat: false, mode: "queue" }).map((item) => item.label),
    ["编辑消息", "关闭排队"],
  );
  assert.deepEqual(
    queueMenuItems({ canOpenSideChat: false, mode: "steer" }).map((item) => item.label),
    ["编辑消息", "启用队列模式"],
  );
  assert.equal(
    queueMenuItems({ canOpenSideChat: false, mode: "queue" }).some((item) => item.id === "side-chat"),
    false,
  );
  assert.deepEqual(
    queueMenuItems({ canOpenSideChat: true, mode: "queue" }).map((item) => item.id),
    ["edit", "side-chat", "queue-mode"],
  );
  assert.equal(queueMenuItems({ canOpenSideChat: true, mode: "steer" })[1]?.label, "在侧边聊天中打开");
});

test("each queued message is its own row", () => {
  assert.deepEqual(queueRows(items), [
    { id: "a", position: 1, preview: "先改提示" },
    { id: "b", position: 2, preview: "再补测试 第二行" },
  ]);
  assert.deepEqual(queueRows([]), []);
});

test("list stays off unless the agent queues and something is waiting", () => {
  assert.equal(queueStripVisible({ supportsQueue: true, count: 2 }), true);
  assert.equal(queueStripVisible({ supportsQueue: false, count: 1 }), false);
  assert.equal(queueStripVisible({ supportsQueue: true, count: 0 }), false);
});

test("preview keeps one message on one line", () => {
  assert.equal(queuePreviewText({ text: "第一行\n第二行" }), "第一行 第二行");
  assert.equal(queuePreviewText({ text: "  ", images: ["C:/shot.png"] }), "shot.png");
  assert.equal(queuePreviewText({ text: "", images: ["a.png", "b.png"] }), "a.png +1");
});
