import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent, SessionEventBody } from "../../../types/index.ts";
import {
  backgroundFailureText,
  backgroundStatusLabel,
  backgroundTasks,
  backgroundTasksByToolCall,
  backgroundTaskTitle,
  isBackgroundLaunchPlaceholder,
  linkedToolForTask,
  resolveBackgroundOutput,
  toolCallsByStreamId,
  visiblePillTasks,
} from "./background-task-display.ts";

function ev(id: string, seq: number, body: SessionEventBody, session_id = "s"): SessionEvent {
  return { id, session_id, seq, ts: seq * 1_000, ...body };
}

test("backgroundTasks returns stable empty collections when absent and latest snapshot per task_id", () => {
  const none: SessionEvent[] = [ev("u1", 1, { kind: "user-message", text: "hi" })];
  assert.equal(backgroundTasks(none), backgroundTasks([]));
  assert.equal(backgroundTasksByToolCall(none), backgroundTasksByToolCall([]));

  const events: SessionEvent[] = [
    ev("1", 1, { kind: "background-task", task_id: "a", task_type: "terminal", title: "pnpm dev", status: "running" }),
    ev("2", 2, { kind: "background-task", task_id: "b", task_type: "local_bash", title: "sleep 10", status: "running" }),
    ev("3", 3, { kind: "background-task", task_id: "a", task_type: "terminal", title: "pnpm dev", status: "stopped" }),
  ];
  const all = backgroundTasks(events);
  assert.deepEqual(all.map((t) => [t.task_id, t.status]), [
    ["a", "stopped"],
    ["b", "running"],
  ]);
  assert.equal(backgroundStatusLabel(all[0]), "已停止");
  assert.equal(backgroundStatusLabel(all[1], "12s"), "12s");
});

test("tool_call_id pairs trimmed keys and unwraps shell wrappers in title", () => {
  const events: SessionEvent[] = [
    ev("t1", 1, { kind: "tool-call", name: "command", summary: "pnpm dev", stream_id: " call_1 ", status: "running" }),
    ev("b1", 2, {
      kind: "background-task",
      task_id: "p1",
      task_type: "terminal",
      tool_call_id: "call_1",
      title: "\"powershell.exe\" -Command 'pnpm dev'",
      status: "running",
    }),
  ];
  const byTool = backgroundTasksByToolCall(events);
  const tools = toolCallsByStreamId(events);
  const all = backgroundTasks(events);

  assert.equal(byTool.get("s:call_1")?.task_id, "p1");
  assert.equal(linkedToolForTask(all[0], tools)?.id, "t1");
  assert.equal(backgroundTaskTitle(all[0], linkedToolForTask(all[0], tools)), "pnpm dev");
  assert.equal(backgroundFailureText(101), "退出码 101");
  assert.equal(backgroundFailureText(undefined), "失败");
});

test("resolveBackgroundOutput prefers output_file, filters CLI launch placeholders, and skips echoed title result", () => {
  assert.equal(isBackgroundLaunchPlaceholder("Command running in background with ID: b5kiw7hh2."), true);
  assert.equal(
    isBackgroundLaunchPlaceholder("Tool is running as a background task with task id: t-1\nTask logs: x"),
    true,
  );
  assert.equal(
    resolveBackgroundOutput({
      detail: "Tool is running as a background task with task id: t-1\nTask logs: x",
      fileText: "",
      result: "Run delayed echo marker",
      rawTitle: "Run delayed echo marker",
    }),
    "",
  );
  assert.equal(
    resolveBackgroundOutput({
      detail: "Command running in background with ID: b5kiw7hh2.",
      fileText: "BG-DONE\n",
      result: "Background command completed (exit code 0)",
    }),
    "BG-DONE",
  );
  assert.equal(
    resolveBackgroundOutput({
      detail: "streaming line 1\nstreaming line 2\n",
      fileText: "",
      result: "",
    }),
    "streaming line 1\nstreaming line 2",
  );
  assert.equal(
    resolveBackgroundOutput({
      detail: "Command running in background with ID: b5kiw7hh2.",
      fileText: "",
      result: "Background command completed (exit code 0)",
      rawTitle: "Run delayed echo marker",
    }),
    "Background command completed (exit code 0)",
  );
});

test("visiblePillTasks hides finished tasks when closed but keeps pinned ones while open", () => {
  const tasks = backgroundTasks([
    ev("1", 1, { kind: "background-task", task_id: "a", task_type: "terminal", title: "a", status: "stopped" }),
    ev("2", 2, { kind: "background-task", task_id: "b", task_type: "terminal", title: "b", status: "running" }),
  ]);
  assert.deepEqual(visiblePillTasks(tasks, new Set(["a"]), false).map((t) => t.task_id), ["b"]);
  assert.deepEqual(visiblePillTasks(tasks, new Set(["a"]), true).map((t) => t.task_id), ["a", "b"]);
});
