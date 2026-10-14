import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent } from "../../../types/index.ts";
import { contextUsageLine } from "./context-usage.ts";

function usage(patch: Partial<Extract<SessionEvent, { kind: "context-usage" }>>): SessionEvent {
  return {
    id: "1",
    session_id: "s",
    seq: 1,
    ts: 1,
    kind: "context-usage",
    source: "partial-usage",
    ...patch,
  };
}

test("context usage stays hidden until an event exists", () => {
  assert.equal(contextUsageLine([]), null);
  assert.equal(contextUsageLine([usage({ source: "partial-usage" })]), null);
});

test("partial usage shows this turn only", () => {
  assert.equal(
    contextUsageLine([usage({ source: "partial-usage", input_tokens: 3, output_tokens: 4 })]),
    "本回合 输入 3 输出 4",
  );
  assert.equal(
    contextUsageLine([usage({ source: "partial-usage", input_tokens: 3, percentage: 90, used_tokens: 1 })]),
    "本回合 输入 3",
  );
});

test("window usage shows reported percentage tokens and model", () => {
  const line = contextUsageLine([
    usage({ source: "partial-usage", input_tokens: 8, output_tokens: 2 }),
    usage({
      source: "get_context_usage",
      percentage: 12.5,
      used_tokens: 1200,
      max_tokens: 8000,
      model: "claude-sonnet",
    }),
  ]);
  assert.equal(line, "12.5% 1200/8000 claude-sonnet · 本回合 输入 8 输出 2");
});
