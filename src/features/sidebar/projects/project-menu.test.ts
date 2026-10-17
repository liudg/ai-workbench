import assert from "node:assert/strict";
import { test } from "node:test";

import { projectMenuItems } from "./project-menu.ts";

test("本地项目把在资源管理器中打开排在移除前面", () => {
  const items = projectMenuItems("D:/work/app");
  assert.deepEqual(
    items.map((item) => (item.type === "action" ? item.label : "—")),
    ["在资源管理器中打开", "—", "从列表移除"],
  );
  assert.equal(items[0]?.type === "action" ? items[0].id : "", "open-folder");
});

test("没有本地路径时不显示在资源管理器中打开", () => {
  for (const path of ["", "   ", null, undefined]) {
    const items = projectMenuItems(path);
    assert.deepEqual(
      items.map((item) => (item.type === "action" ? item.id : "separator")),
      ["remove"],
    );
  }
});
