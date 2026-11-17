import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent, SessionEventBody } from "../../../types/index.ts";
import {
  activeThinkingId,
  activityOpenAfterSettle,
  thinkingBlockOpen,
  thinkingOverridesAfterSettle,
  toggleThinkingBlock,
  toggleToolGroup,
  toolGroupOpen,
} from "./activity-open.ts";

function event(id: string, body: SessionEventBody): SessionEvent {
  return { id, session_id: "s", seq: 1, ts: 1, ...body };
}

test("tool rows start collapsed", () => {
  const open = new Set<string>();
  assert.equal(toolGroupOpen(open, "mcp-1"), false);
  assert.equal(toolGroupOpen(open, "cmd-1"), false);
});

test("toggle opens one row and a second toggle closes it", () => {
  let open = new Set<string>();
  open = toggleToolGroup(open, "mcp-1");
  assert.equal(toolGroupOpen(open, "mcp-1"), true);
  assert.equal(toolGroupOpen(open, "cmd-1"), false);
  open = toggleToolGroup(open, "cmd-1");
  assert.equal(toolGroupOpen(open, "mcp-1"), true);
  assert.equal(toolGroupOpen(open, "cmd-1"), true);
  open = toggleToolGroup(open, "mcp-1");
  assert.equal(toolGroupOpen(open, "mcp-1"), false);
  assert.equal(toolGroupOpen(open, "cmd-1"), true);
});

test("finishing a turn drops opens from the live phase", () => {
  const live = toggleToolGroup(toggleToolGroup(new Set<string>(), "mcp-1"), "cmd-1");
  const settled = activityOpenAfterSettle(live, false, true);
  assert.equal(settled.size, 0);
  assert.equal(toolGroupOpen(settled, "mcp-1"), false);
  assert.equal(toolGroupOpen(settled, "cmd-1"), false);
});

test("a click after the turn has finished stays open", () => {
  const cleared = activityOpenAfterSettle(new Set(["mcp-1"]), false, true);
  const opened = toggleToolGroup(cleared, "mcp-1");
  const still = activityOpenAfterSettle(opened, true, true);
  assert.equal(still, opened);
  assert.equal(toolGroupOpen(still, "mcp-1"), true);
});

test("leaving the settled state does not clear a later click", () => {
  const opened = toggleToolGroup(new Set<string>(), "mcp-1");
  assert.equal(activityOpenAfterSettle(opened, true, false), opened);
});

test("live trailing thinking auto-opens until a later visible event or settle arrives", () => {
  const t1 = event("t1", { kind: "thinking", text: "第一步推理" });
  const silent = event("u1", { kind: "context-usage", source: "partial-usage" });
  const emptyThink = event("t-empty", { kind: "thinking", text: "   " });
  const placeholderThink = event("t-placeholder", { kind: "thinking", text: "思考中…" });
  const approval = event("p1", {
    kind: "prompt",
    prompt_id: "ask",
    prompt_kind: "approval",
    question: "允许？",
    options: [],
    questions: [],
  });
  const opaqueErr = event("e1", { kind: "error", message: "unknown" });
  const cmd = event("k1", { kind: "tool-call", name: "command", summary: "ls" });
  const t2 = event("t2", { kind: "thinking", text: "第二步推理" });
  const reply = event("a1", { kind: "agent-message", text: "正式答复" });

  assert.equal(activeThinkingId([t1], true, false), "t1");
  assert.equal(activeThinkingId([t1, silent, emptyThink, approval, opaqueErr], true, false), "t1");
  assert.equal(activeThinkingId([placeholderThink], true, false), null);
  assert.equal(activeThinkingId([t1, cmd, placeholderThink], true, false), null);
  assert.equal(activeThinkingId([t1, cmd], true, false), null);
  assert.equal(activeThinkingId([t1, cmd, t2], true, false), "t2");
  assert.equal(activeThinkingId([t1, cmd, t2, reply], true, false), null);
  assert.equal(activeThinkingId([t1, cmd, t2], false, false), null);
  assert.equal(activeThinkingId([t1, cmd, t2], true, true), null);

  let overrides: ReadonlyMap<string, boolean> = new Map();
  assert.equal(thinkingBlockOpen(overrides, "t1", "t2"), false);
  assert.equal(thinkingBlockOpen(overrides, "t2", "t2"), true);
  overrides = toggleThinkingBlock(overrides, "t2", "t2");
  assert.equal(thinkingBlockOpen(overrides, "t2", "t2"), false);
  overrides = toggleThinkingBlock(overrides, "t1", "t2");
  assert.equal(thinkingBlockOpen(overrides, "t1", "t2"), true);

  const afterSettle = thinkingOverridesAfterSettle(overrides, false, true);
  assert.equal(afterSettle.size, 0);
  assert.equal(thinkingBlockOpen(afterSettle, "t1", null), false);
});
