import assert from "node:assert/strict";
import { test } from "node:test";

import { diffScopeMenu, filesForScope } from "./scope.ts";

const PROVIDED = [
  { id: "turn", label: "上一轮", source: "turn" },
  { id: "uncommitted", label: "未提交", source: "git" },
  { id: "unstaged", label: "未暂存", source: "git" },
  { id: "staged", label: "已暂存", source: "git" },
];

test("an empty provider list stays empty until scopes arrive", () => {
  assert.deepEqual(diffScopeMenu([], { turn_diff: true, per_file_patch: true, git_scopes: true }), []);
});

test("diff scope menu follows the provider and change capabilities", () => {
  assert.deepEqual(
    diffScopeMenu(PROVIDED, { turn_diff: true, per_file_patch: true, git_scopes: true }).map((item) => item.label),
    ["上一轮", "未提交", "未暂存", "已暂存"],
  );
  assert.deepEqual(
    diffScopeMenu(PROVIDED, { turn_diff: true, per_file_patch: true, git_scopes: false }).map((item) => item.id),
    ["turn"],
  );
  assert.deepEqual(
    diffScopeMenu(PROVIDED, { turn_diff: false, per_file_patch: false, git_scopes: true }).map((item) => item.id),
    ["uncommitted", "unstaged", "staged"],
  );
});

test("the previous turn stays on event files", () => {
  const turn = [{ path: "notes/fake.md", status: "M" as const, added: 1, removed: 0, diff: "+a" }];
  const git = [{ path: "other.txt", status: "A" as const, added: 1, removed: 0, diff: "+b" }];
  assert.equal(filesForScope({ source: "turn" }, turn, git)[0]?.path, "notes/fake.md");
  assert.equal(filesForScope({ source: "git" }, turn, git)[0]?.path, "other.txt");
});
