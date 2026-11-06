import assert from "node:assert/strict";
import { test } from "node:test";

import { sessionMenuItems } from "./session-menu.ts";

test("every session has a copy submenu, with delete last and marked danger", () => {
  const items = sessionMenuItems({ pinned: false, archived: false, forks: [] });
  assert.deepEqual(
    items.map((item) => item.label),
    ["重命名", "置顶", "复制", "归档", "删除"],
  );
  assert.deepEqual(items.find((item) => item.id === "copy")?.children?.map((item) => [item.id, item.label]), [
    ["copy-markdown", "复制为 Markdown"],
    ["copy-workdir", "复制工作目录"],
  ]);
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
    ["重命名", "置顶", "分叉", "复制", "归档", "删除"],
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
    ["重命名", "置顶", "分叉", "复制", "归档", "删除"],
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
