import assert from "node:assert/strict";
import { test } from "node:test";

import { sessionMenuItems } from "./session-menu.ts";

const codex = {
  supports_rename: true,
  supports_archive: true,
  supports_delete: true,
  supports_fork: true,
};

test("codex menu is four flat items and ignores fork", () => {
  const items = sessionMenuItems({ caps: codex, pinned: false, archived: false });
  assert.deepEqual(
    items.map((item) => item.label),
    ["重命名", "置顶", "归档", "删除"],
  );
  assert.equal(items.some((item) => item.label.includes("分叉")), false);
  assert.equal(items[items.length - 1]?.danger, true);
  assert.equal(items.find((item) => item.id === "rename")?.label, "重命名");
});

test("pin and archive labels flip when the session is already in that state", () => {
  const items = sessionMenuItems({ caps: codex, pinned: true, archived: true });
  assert.equal(items.find((item) => item.id === "pin")?.label, "取消置顶");
  assert.equal(items.find((item) => item.id === "archive")?.label, "取消归档");
});

test("claude keeps rename and pin, and does not offer archive or delete", () => {
  const items = sessionMenuItems({
    caps: { supports_rename: true, supports_archive: false, supports_delete: false },
    pinned: false,
    archived: false,
  });
  assert.deepEqual(
    items.map((item) => item.id),
    ["rename", "pin"],
  );
});

test("an agent without session caps still gets pin", () => {
  const items = sessionMenuItems({ caps: undefined, pinned: false, archived: false });
  assert.deepEqual(
    items.map((item) => item.id),
    ["pin"],
  );
});
