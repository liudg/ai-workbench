import assert from "node:assert/strict";
import { test } from "node:test";

import { projectMenuItems, removeConfirmLabel } from "./project-menu.ts";

function labels(path: string | null | undefined, pinned: boolean) {
  return projectMenuItems({ path, pinned }).map((item) => (item.type === "action" ? item.label : "—"));
}

test("未置顶的本地项目把置顶和编辑放在打开与移除前面", () => {
  assert.deepEqual(labels("D:/work/app", false), [
    "置顶",
    "编辑",
    "导入 CLI 会话",
    "—",
    "在资源管理器中打开",
    "—",
    "移除项目",
  ]);
  const items = projectMenuItems({ path: "D:/work/app", pinned: false });
  assert.equal(items[0]?.type === "action" ? items[0].id : "", "pin");
  assert.equal(items[1]?.type === "action" ? items[1].id : "", "edit");
});

test("已经置顶时菜单写成取消置顶", () => {
  const items = projectMenuItems({ path: "D:/work/app", pinned: true });
  assert.equal(items[0]?.type === "action" ? items[0].label : "", "取消置顶");
  const pinned = labels("D:/work/app", true);
  assert.equal(pinned[4], "在资源管理器中打开");
  assert.equal(pinned[pinned.length - 1], "移除项目");
});

test("没有本地路径时不显示在资源管理器中打开", () => {
  for (const path of ["", "   ", null, undefined]) {
    assert.deepEqual(
      projectMenuItems({ path, pinned: false }).map((item) =>
        item.type === "action" ? item.id : "separator",
      ),
      ["pin", "edit", "import", "separator", "remove"],
    );
  }
});

test("移除确认写明会一起删掉几个会话", () => {
  assert.equal(removeConfirmLabel(0), "确认移除？");
  assert.equal(removeConfirmLabel(3), "删除 3 个会话并移除？");
});
