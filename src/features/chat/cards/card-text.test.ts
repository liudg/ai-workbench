import assert from "node:assert/strict";
import { test } from "node:test";

import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import { changeActions, editedFilesLabel, FILE_LIST_LIMIT, visibleChangeFiles } from "./card-text.ts";

test("change card actions are view and show-more, never undo", () => {
  assert.deepEqual(changeActions(1, true, false), [DESKTOP_ZH.viewChanges]);
  assert.deepEqual(changeActions(FILE_LIST_LIMIT + 1, true, false), [
    DESKTOP_ZH.viewChanges,
    DESKTOP_ZH.showMore,
  ]);
  assert.equal(changeActions(8, true, true).includes(DESKTOP_ZH.showMore), false);
  const labels = changeActions(8, true, false);
  assert.equal(labels.includes("撤销"), false);
  assert.equal(visibleChangeFiles([1, 2, 3, 4], true, false).length, FILE_LIST_LIMIT);
  assert.deepEqual(visibleChangeFiles([1, 2, 3, 4], true, true), [1, 2, 3, 4]);
  assert.deepEqual(visibleChangeFiles([1, 2], false, false), []);
});

test("change card title names the file, and deletions use an ascii hyphen", () => {
  assert.equal(editedFilesLabel([{ path: "src/annotate.html" }]), "已编辑 annotate.html");
  assert.equal(editedFilesLabel([{ path: "C:\\work\\a.ts" }]), "已编辑 a.ts");
  assert.equal(editedFilesLabel([{ path: "a.ts" }, { path: "b.ts" }]), "已编辑 2 个文件");
});
