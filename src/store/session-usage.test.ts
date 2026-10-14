import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent, SessionEventBody } from "../types/index.ts";
import { accumulateSessionUsage } from "./session-usage.ts";

function event(seq: number, body: SessionEventBody): SessionEvent {
  return { id: `e${seq}`, session_id: "s", seq, ts: seq, ...body };
}

test("codex snapshots replace each other and ignore the per-turn last count", () => {
  const usage = accumulateSessionUsage([
    event(1, {
      kind: "session-usage",
      scope: "snapshot",
      input_tokens: 60,
      output_tokens: 10,
      cache_read_tokens: 40,
    }),
    event(2, {
      kind: "context-usage",
      source: "partial-usage",
      input_tokens: 999,
      output_tokens: 999,
    }),
    event(3, {
      kind: "session-usage",
      scope: "snapshot",
      input_tokens: 170,
      output_tokens: 30,
      cache_read_tokens: 80,
    }),
  ]);
  assert.deepEqual(usage, { total: 280, input: 170, output: 30, cacheRead: 80 });
});

test("claude deltas dedupe by key and sit on top of the history snapshot", () => {
  const usage = accumulateSessionUsage([
    event(2, {
      kind: "session-usage",
      scope: "delta",
      key: "result:turn-2",
      input_tokens: 3,
      output_tokens: 4,
      cache_read_tokens: 1,
      cache_write_tokens: 2,
    }),
    event(1, {
      kind: "session-usage",
      scope: "snapshot",
      input_tokens: 10,
      cache_read_tokens: 4,
      cache_write_tokens: 2,
    }),
    event(3, {
      kind: "session-usage",
      scope: "delta",
      key: "assistant:msg_side",
      input_tokens: 8,
      cache_read_tokens: 2,
    }),
    event(4, {
      kind: "session-usage",
      scope: "delta",
      key: "result:turn-2",
      input_tokens: 3,
      output_tokens: 4,
      cache_read_tokens: 1,
      cache_write_tokens: 2,
    }),
  ]);
  assert.deepEqual(usage, {
    total: 36,
    input: 21,
    output: 4,
    cacheRead: 7,
    cacheWrite: 4,
  });
});

test("a later snapshot drops deltas that came before it", () => {
  const usage = accumulateSessionUsage([
    event(1, {
      kind: "session-usage",
      scope: "delta",
      key: "result:old",
      input_tokens: 5,
      output_tokens: 5,
    }),
    event(2, {
      kind: "session-usage",
      scope: "snapshot",
      input_tokens: 10,
      output_tokens: 1,
    }),
    event(3, {
      kind: "session-usage",
      scope: "delta",
      key: "result:new",
      output_tokens: 4,
    }),
  ]);
  assert.deepEqual(usage, { total: 15, input: 10, output: 5 });
});

test("missing usage renders nothing and omitted buckets stay omitted", () => {
  assert.equal(accumulateSessionUsage([]), null);
  assert.equal(
    accumulateSessionUsage([
      event(1, { kind: "context-usage", source: "get_context_usage", used_tokens: 45137, max_tokens: 200000 }),
    ]),
    null,
  );
  assert.equal(
    accumulateSessionUsage([event(1, { kind: "session-usage", scope: "delta" })]),
    null,
  );
  const partial = accumulateSessionUsage([
    event(1, { kind: "session-usage", scope: "snapshot", output_tokens: 4 }),
  ]);
  assert.deepEqual(partial, { total: 4, output: 4 });
  assert.equal(partial && "input" in partial, false);
  assert.equal(JSON.stringify(partial).includes("cost"), false);
});
