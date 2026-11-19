import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent, SessionEventBody, ToolStatus } from "../../../types/index.ts";
import { liveActivityLabel, toolFailureText, toolState } from "./tool-status.ts";

function event(id: string, body: SessionEventBody): SessionEvent {
  return { id, session_id: "s", seq: 1, ts: 1, ...body };
}

function tool(
  id: string,
  name: string,
  summary: string,
  status?: ToolStatus,
  exit_code?: number,
): Extract<SessionEvent, { kind: "tool-call" }> {
  return { id, session_id: "s", seq: 1, ts: 1, kind: "tool-call", name, summary, status, exit_code };
}

test("a running tool only spins while its turn is live", () => {
  const running = tool("a", "command", "pnpm test", "running");
  assert.equal(toolState(running, true), "running");
  assert.equal(toolState(running, false), "done");
  assert.equal(toolState(tool("b", "command", "ls"), true), "done");
  assert.equal(toolState(tool("c", "command", "false", "failed", 1), false), "failed");
});

test("failure text prefers the exit code", () => {
  assert.equal(toolFailureText(tool("a", "command", "x", "failed", 3)), "退出码 3");
  assert.equal(toolFailureText(tool("b", "Edit", "x", "failed")), "失败");
});

test("linked background task overrides settled turn and filters -1 stop exit code", () => {
  const cmd = tool("a", "command", "sleep 20", "completed");
  const killedCmd = tool("b", "command", "pnpm dev", "failed", -1);
  const bg = (status: "running" | "completed" | "failed" | "stopped", exit_code?: number) => ({
    id: "bg1",
    session_id: "s",
    seq: 2,
    ts: 2,
    kind: "background-task" as const,
    task_id: "t1",
    task_type: "terminal",
    tool_call_id: "a",
    title: "sleep 20",
    status,
    exit_code,
  });

  assert.equal(toolState(cmd, false, bg("running")), "running");
  assert.equal(toolState(killedCmd, false, bg("stopped", -1)), "stopped");
  assert.equal(toolState(cmd, false, bg("failed", 101)), "failed");
  assert.equal(toolFailureText(cmd, bg("failed", 101)), "退出码 101");
  assert.equal(toolState(cmd, false, bg("completed", 0)), "done");
});

test("live label follows what the turn is doing now", () => {
  const thinking = event("t", { kind: "thinking", text: "…" });
  const status = event("s", { kind: "status-changed", status: "running" });
  assert.equal(liveActivityLabel([]), "正在处理");
  assert.equal(liveActivityLabel([thinking, status]), "正在思考");
  assert.equal(
    liveActivityLabel([thinking, tool("a", "command", "pnpm test", "running")]),
    "正在运行 pnpm test",
  );
  assert.equal(
    liveActivityLabel([tool("a", "command", "pnpm test", "completed"), thinking]),
    "正在思考",
  );
  assert.equal(
    liveActivityLabel([tool("a", "mcp__chrome__navigate", "", "running")]),
    "正在调用 navigate",
  );
  assert.equal(liveActivityLabel([tool("w", "web_search", "rust", "running")]), "正在搜索网页");
  assert.equal(
    liveActivityLabel([event("m", { kind: "agent-message", text: "结", phase: "final-answer" })]),
    "正在回复",
  );
  assert.equal(
    liveActivityLabel([
      tool("a", "command", "ls", "completed"),
      event("m", { kind: "agent-message", text: "接着看", phase: "commentary" }),
    ]),
    "正在处理",
  );
});
