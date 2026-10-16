import assert from "node:assert/strict";
import { test } from "node:test";

import { filterHopAction, matchingFilter } from "./filter-hop.ts";

test("a cancelled filter retries instead of leaving the tree spinning", () => {
  assert.equal(filterHopAction({ stopped: false, cancelled: true, ready: true }), "retry");
  assert.equal(filterHopAction({ stopped: false, cancelled: false, ready: false }), "retry");
  assert.equal(filterHopAction({ stopped: false, cancelled: false, ready: true }), "done");
  assert.equal(filterHopAction({ stopped: true, cancelled: true, ready: false }), "stop");
});

test("a filter result from another project is not shown", () => {
  const found = { projectId: "left", query: "lab", paths: ["a.ts"], truncated: false };
  assert.equal(matchingFilter(found, "lab", "right"), null);
  assert.equal(matchingFilter(found, "readme", "left"), null);
  assert.deepEqual(matchingFilter(found, "lab", "left"), found);
});
