import assert from "node:assert/strict";
import { test } from "node:test";

import { nestLines, splitSubtasks } from "./session-nesting.ts";

const row = (id: string, parentTaskId: string | null = null) => ({ id, parentTaskId });

test("subtasks follow their parent and fold away with it", () => {
  const { roots, childrenOf } = splitSubtasks([row("a"), row("c1", "p"), row("p"), row("c2", "p")]);
  assert.deepEqual(
    roots.map((task) => task.id),
    ["a", "p"],
  );
  const lines = nestLines(roots, childrenOf, new Set());
  assert.deepEqual(
    lines.map((line) => [line.task.id, line.depth, line.subtasks]),
    [
      ["a", 0, 0],
      ["p", 0, 2],
      ["c1", 1, 0],
      ["c2", 1, 0],
    ],
  );
  const folded = nestLines(roots, childrenOf, new Set(["p"]));
  assert.deepEqual(
    folded.map((line) => line.task.id),
    ["a", "p"],
  );
  assert.equal(folded[1].collapsed, true);
});

test("nested sessions lie flat under the top task, however deep", () => {
  const { roots, childrenOf } = splitSubtasks([row("leaf", "mid"), row("mid", "top"), row("top")]);
  assert.deepEqual(roots.map((task) => task.id), ["top"]);
  assert.deepEqual(
    nestLines(roots, childrenOf, new Set()).map((line) => [line.task.id, line.depth]),
    [["top", 0], ["leaf", 1], ["mid", 1]],
  );
});

test("a subtask whose parent is not in the list stands on its own", () => {
  const { roots, childrenOf } = splitSubtasks([row("c", "gone")]);
  assert.deepEqual(
    roots.map((task) => task.id),
    ["c"],
  );
  assert.equal(childrenOf.size, 0);
});
