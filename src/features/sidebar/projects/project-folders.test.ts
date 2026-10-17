import assert from "node:assert/strict";
import { test } from "node:test";

import { projectFolders, sameFolder } from "./project-folders.ts";

test("没有 folders 时用项目路径", () => {
  assert.deepEqual(projectFolders({ path: "D:/work/app" }), ["D:/work/app"]);
  assert.deepEqual(projectFolders({ path: "  " }), []);
  assert.deepEqual(projectFolders({ path: "D:/work/app", folders: [] }), ["D:/work/app"]);
});

test("已保存的源文件夹优先于项目路径", () => {
  assert.deepEqual(
    projectFolders({ path: "D:/work/app", folders: ["D:/work/app", " D:/notes "] }),
    ["D:/work/app", "D:/notes"],
  );
});

test("Windows 路径按同一目录去重", () => {
  assert.equal(sameFolder("D:/work/app/", "d:\\work\\app"), true);
  assert.equal(sameFolder("/work/App", "/work/app"), false);
});
