import assert from "node:assert/strict";
import { test } from "node:test";

import { diffScopeMenu } from "./scope.ts";

test("diff scope menu matches the Codex previous-turn list", () => {
  assert.deepEqual(
    diffScopeMenu().map((item) => [item.label, item.submenu]),
    [
      ["上一轮", false],
      ["未提交", false],
      ["未暂存", false],
      ["已暂存", false],
      ["已提交", true],
      ["分支", true],
    ],
  );
});
