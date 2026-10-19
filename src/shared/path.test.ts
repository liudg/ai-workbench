import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizePath,
  pathCrumb,
  relativeToProject,
  relativizeDisplayText,
  relativizeFiles,
  workspaceRootLabel,
} from "./path.ts";

test("open-files root label is the drive letter", () => {
  assert.equal(workspaceRootLabel("F:\\sample\\mercury_dev"), "F:");
  assert.equal(workspaceRootLabel("C:/work/app"), "C:");
  assert.equal(workspaceRootLabel("/home/project"), "");
});

test("paths under the project root become project-relative", () => {
  assert.equal(relativeToProject("D:\\one-verify\\panel-demo\\src\\core\\A.ts", "D:\\one-verify\\panel-demo"), "src/core/A.ts");
  assert.equal(relativeToProject("/home/me/proj/docs/gen-system.md", "/home/me/proj"), "docs/gen-system.md");
  assert.equal(relativeToProject("src/core/A.ts", "D:\\one-verify\\panel-demo"), "src/core/A.ts");
  assert.equal(relativeToProject("C:\\Windows\\note.txt", "D:\\one-verify\\panel-demo"), "C:/Windows/note.txt");
  assert.equal(relativeToProject("D:\\one-verify\\panel-demo", "D:\\one-verify\\panel-demo"), "");
  assert.equal(
    relativizeDisplayText("读取 D:\\one-verify\\panel-demo\\docs\\gen-system.md", "D:\\one-verify\\panel-demo"),
    "读取 docs/gen-system.md",
  );
  assert.equal(
    relativizeDisplayText("读取 C:\\outside\\note.txt", "D:\\one-verify\\panel-demo"),
    "读取 C:\\outside\\note.txt",
  );
  assert.deepEqual(
    relativizeFiles(
      [{ path: "D:\\one-verify\\panel-demo\\src\\core\\A.ts", added: 1 }],
      "D:\\one-verify\\panel-demo",
    ),
    [{ path: "src/core/A.ts", added: 1 }],
  );
});

test("a slash before a windows drive is not a unix root", () => {
  assert.equal(
    normalizePath("/C:/Users/admin/Documents/AI Workbench/snake.html"),
    "C:/Users/admin/Documents/AI Workbench/snake.html",
  );
  assert.equal(normalizePath("\\C:\\Users\\admin\\snake.html"), "C:/Users/admin/snake.html");
  assert.equal(normalizePath("/C:/foo/../bar.html"), "C:/bar.html");
  assert.equal(normalizePath("/home/me/notes.md"), "/home/me/notes.md");
});

test("preview titles space the path separators", () => {
  assert.equal(pathCrumb("Scripts/GameUI/Module/GemRedDot.cs"), "Scripts / GameUI / Module / GemRedDot.cs");
  assert.equal(pathCrumb("src\\core\\A.ts"), "src / core / A.ts");
});
