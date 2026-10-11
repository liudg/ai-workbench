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
    diffScopeMenu(PROVIDED, { turn_diff: true, per_file_patch: true, git_scopes: true }).map((item) => [
      item.label,
      item.submenu,
    ]),
    [
      ["上一轮", false],
      ["未提交", false],
      ["未暂存", false],
      ["已暂存", false],
      ["已提交", true],
      ["分支", true],
    ],
  );
  assert.deepEqual(
    diffScopeMenu(PROVIDED, { turn_diff: true, per_file_patch: true, git_scopes: false }).map((item) => item.id),
    ["turn"],
  );
  assert.deepEqual(
    diffScopeMenu(PROVIDED, { turn_diff: false, per_file_patch: false, git_scopes: true }).map((item) => item.id),
    ["uncommitted", "unstaged", "staged", "committed", "branch"],
  );
});

test("the previous turn stays on event files", () => {
  const turn = [{ path: "notes/fake.md", status: "M" as const, added: 1, removed: 0, diff: "+a" }];
  const git = [{ path: "other.txt", status: "A" as const, added: 1, removed: 0, diff: "+b" }];
  assert.equal(filesForScope({ source: "turn", submenu: false }, turn, git)[0]?.path, "notes/fake.md");
  assert.equal(filesForScope({ source: "git", submenu: false }, turn, git)[0]?.path, "other.txt");
  assert.equal(filesForScope({ source: "git", submenu: true }, turn, git)[0]?.path, "notes/fake.md");
});
