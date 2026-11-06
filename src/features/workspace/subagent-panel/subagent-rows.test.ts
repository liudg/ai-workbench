import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent } from "../../../types/index.ts";
import type { TaskEntry } from "../../tasks/types.ts";
import { descendantTasks, nativeRow, subagentCards, taskRow } from "./subagent-rows.ts";

function task(id: string, parentTaskId?: string, extra: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id,
    title: id,
    workspace: { kind: "root" },
    parentTaskId,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    sessions: [],
    attention: { state: "working", unread: false, updatedAt: 1 },
    ...extra,
  };
}

test("descendants cover every level and skip archived tasks", () => {
  const tasks = [
    task("leaf", "mid"),
    task("mid", "root"),
    task("root"),
    task("gone", "root", { archivedAt: 2 }),
    task("other"),
    task("under-gone", "gone"),
  ];
  assert.deepEqual(descendantTasks(tasks, "root").map((item) => item.id).sort(), ["leaf", "mid", "under-gone"]);
  assert.deepEqual(descendantTasks(tasks, "mid").map((item) => item.id), ["leaf"]);
});

test("a nested session waiting for the user still counts as active", () => {
  const row = taskRow(task("a", "b", { attention: { state: "needs-input", ask: "approval", unread: true, updatedAt: 1 } }), "codex-cli");
  assert.equal(row.active, true);
  assert.equal(taskRow(task("a", "b", { attention: { state: "done", unread: false, updatedAt: 1 } }), "codex-cli").active, false);
});

test("only the latest card of each subagent is kept", () => {
  const card = (id: string, seq: number, status: "running" | "failed"): SessionEvent => ({
    id,
    session_id: "s",
    seq,
    ts: seq,
    kind: "subagent",
    subagent_id: "a",
    title: "审查",
    status,
  });
  const cards = subagentCards([card("1", 1, "running"), card("2", 2, "failed")]);
  assert.equal(cards.length, 1);
  const row = nativeRow(cards[0], "claude-code");
  assert.equal(row.status, "失败");
  assert.equal(row.active, false);
});
