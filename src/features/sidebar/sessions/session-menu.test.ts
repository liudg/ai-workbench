import assert from "node:assert/strict";
import { test } from "node:test";

import { sessionMenuItems } from "./session-menu.ts";

test("every session gets the same four items, delete last and marked danger", () => {
  const items = sessionMenuItems({ pinned: false, archived: false });
  assert.deepEqual(
    items.map((item) => item.label),
    ["重命名", "置顶", "归档", "删除"],
  );
  assert.equal(items[items.length - 1]?.danger, true);
});

test("pin and archive labels flip when the session is already in that state", () => {
  const items = sessionMenuItems({ pinned: true, archived: true });
  assert.equal(items.find((item) => item.id === "pin")?.label, "取消置顶");
  assert.equal(items.find((item) => item.id === "archive")?.label, "取消归档");
});
