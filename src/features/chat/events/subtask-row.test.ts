import assert from "node:assert/strict";
import { test } from "node:test";

import { subtaskDetail, subtaskStatus } from "./subtask-row.ts";

const base = { unread: false, updatedAt: 1 };

test("subtask rows follow the subtask's attention, waiting ones use the sidebar's pill", () => {
  assert.deepEqual(
    [subtaskStatus({ ...base, state: "working" }).label, subtaskStatus({ ...base, state: "working" }).running],
    ["运行中", true],
  );
  const approval = subtaskStatus({ ...base, state: "needs-input", ask: "approval" });
  assert.equal(approval.label, "待批准");
  assert.equal(approval.textClass, "text-wb-warn");
  assert.equal(subtaskStatus({ ...base, state: "failed" }).textClass, "text-wb-danger");
  assert.equal(subtaskStatus({ ...base, state: "done" }).label, "完成");
  assert.equal(subtaskStatus({ ...base, state: "idle" }).label, "已停止");
});

test("the detail line is the last thing it said, on one line", () => {
  assert.equal(subtaskDetail({ ...base, state: "working", preview: "  正在改\n copy.ts " }), "正在改 copy.ts");
  assert.equal(subtaskDetail({ ...base, state: "done" }), "");
});
