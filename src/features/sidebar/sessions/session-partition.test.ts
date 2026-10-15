import assert from "node:assert/strict";
import { test } from "node:test";

import { partitionSidebarSessions } from "./session-partition.ts";

test("archived sessions leave the default list and keep their order", () => {
  const { active, archived } = partitionSidebarSessions([
    { id: "a" },
    { id: "b", archived: true },
    { id: "c", archived: false },
    { id: "d", archived: true },
  ]);
  assert.deepEqual(
    active.map((item) => item.id),
    ["a", "c"],
  );
  assert.deepEqual(
    archived.map((item) => item.id),
    ["b", "d"],
  );
});
