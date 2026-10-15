import assert from "node:assert/strict";
import { test } from "node:test";

import { activityOpenAfterSettle, toggleToolGroup, toolGroupOpen } from "./activity-open.ts";

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
