import assert from "node:assert/strict";
import { test } from "node:test";

import { sessionMenuItems } from "./session-menu.ts";

test("without fork targets every session gets the same four items, delete last and marked danger", () => {
  const items = sessionMenuItems({ pinned: false, archived: false, forks: [] });
  assert.deepEqual(
    items.map((item) => item.label),
    ["重命名", "置顶", "归档", "删除"],
  );
  assert.equal(items[items.length - 1]?.danger, true);
});

test("pin and archive labels flip when the session is already in that state", () => {
  const items = sessionMenuItems({ pinned: true, archived: true, forks: [] });
  assert.equal(items.find((item) => item.id === "pin")?.label, "取消置顶");
  assert.equal(items.find((item) => item.id === "archive")?.label, "取消归档");
});

test("a single fork target is a plain item between pin and archive", () => {
  const items = sessionMenuItems({
    pinned: false,
    archived: false,
    forks: [{ agent: "codex-cli", name: "Codex", same: true }],
  });
  assert.deepEqual(
    items.map((item) => item.label),
    ["重命名", "置顶", "分叉", "归档", "删除"],
  );
  const fork = items.find((item) => item.id === "fork");
  assert.equal(fork?.agent, "codex-cli");
  assert.equal(fork?.children, undefined);
});

test("several fork targets fold into one 分叉 submenu, one entry per agent", () => {
  const items = sessionMenuItems({
    pinned: false,
    archived: false,
    forks: [
      { agent: "codex-cli", name: "Codex", same: true },
      { agent: "claude-code", name: "Claude Code", same: false },
    ],
  });
  assert.deepEqual(
    items.map((item) => item.label),
    ["重命名", "置顶", "分叉", "归档", "删除"],
  );
  const fork = items.find((item) => item.id === "fork");
  assert.equal(fork?.agent, undefined);
  assert.deepEqual(
    fork?.children?.map((item) => [item.key, item.label, item.agent]),
    [
      ["fork:codex-cli", "Codex（当前）", "codex-cli"],
      ["fork:claude-code", "Claude Code", "claude-code"],
    ],
  );
});
