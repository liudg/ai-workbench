import assert from "node:assert/strict";
import { test } from "node:test";

import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import {
  breadcrumbSegments,
  dropdownTreeQuery,
  isDirectorySelection,
  openModeForSegment,
  previewSelection,
  previewShellStatus,
} from "./file-preview-nav.ts";

const ACTIVE = "ThirdPersonWorldLab/docs/StaticWorldExpansionPlan.md";

test("directories stay in the tree and files open as a preview", () => {
  assert.equal(isDirectorySelection("Assets/Scripts/"), true);
  assert.equal(isDirectorySelection("Assets\\Scripts\\"), true);
  assert.equal(isDirectorySelection("Assets/Scripts", "dir"), true);
  assert.equal(previewSelection("Assets/Scripts/", "dir"), null);
  assert.equal(previewSelection("Assets/Scripts", "dir"), null);
  assert.deepEqual(previewSelection(ACTIVE), { path: ACTIVE, isPreview: true });
  assert.deepEqual(previewSelection(` ${ACTIVE} `), { path: ACTIVE, isPreview: true });
});

test("breadcrumb segments use workspace mode until the file name", () => {
  const segments = breadcrumbSegments(ACTIVE);
  assert.deepEqual(
    segments.map((segment) => `${segment.label}:${openModeForSegment(segment.last)}`),
    ["ThirdPersonWorldLab:workspace", "docs:workspace", "StaticWorldExpansionPlan.md:file"],
  );
  assert.deepEqual(breadcrumbSegments(""), []);
  assert.equal(breadcrumbSegments("notes\\宝石.md")[0]?.path, "notes");
});

test("the same dropdown tree expands a directory segment and lists siblings for the file", () => {
  const folder = dropdownTreeQuery({
    activePath: ACTIVE,
    segmentPath: "ThirdPersonWorldLab",
    last: false,
    workspaceRoot: "C:/work",
  });
  assert.equal(folder.openMode, "workspace");
  assert.equal(folder.surface, "dropdown");
  assert.equal(folder.shouldExpandActivePath, true);
  assert.equal(folder.includeHidden, true);
  assert.equal(folder.revealSelectedPath, true);
  assert.equal(folder.directoryPath, "ThirdPersonWorldLab");
  assert.deepEqual(folder.expandedPaths, ["ThirdPersonWorldLab/docs"]);

  const file = dropdownTreeQuery({
    activePath: ACTIVE,
    segmentPath: ACTIVE,
    last: true,
    workspaceRoot: "C:/work",
  });
  assert.equal(file.openMode, "file");
  assert.equal(file.shouldExpandActivePath, false);
  assert.equal(file.directoryPath, "ThirdPersonWorldLab/docs");
  assert.deepEqual(file.expandedPaths, []);
  assert.equal(file.surface, folder.surface);
});

test("a root file lists the workspace root without expanding", () => {
  const file = dropdownTreeQuery({
    activePath: "README.md",
    segmentPath: "README.md",
    last: true,
    workspaceRoot: "/work",
  });
  assert.equal(file.directoryPath, "");
  assert.deepEqual(file.expandedPaths, []);
});

test("preview chrome status stays on the shell, not on a markdown mode", () => {
  assert.equal(previewShellStatus({ path: "", phase: "idle" }), "empty");
  assert.equal(previewShellStatus({ path: "a.ts", phase: "loading" }), "loading");
  assert.equal(previewShellStatus({ path: "a.ts", phase: "error" }), "error");
  assert.equal(previewShellStatus({ path: "a.ts", phase: "ready", truncated: true }), "tooLarge");
  assert.equal(previewShellStatus({ path: "a.ts", phase: "ready", kind: "binary" }), "unsupported");
  assert.equal(previewShellStatus({ path: "pack.zip", phase: "loading" }), "unsupported");
  assert.equal(previewShellStatus({ path: "notes.md", phase: "ready", kind: "markdown" }), "ready");
  assert.equal(DESKTOP_ZH.toggleFileTree, "切换文件树");
  assert.notEqual(DESKTOP_ZH.toggleFileTree, DESKTOP_ZH.diffShowFile);
  assert.equal(DESKTOP_ZH.openFiles, "打开文件");
  assert.equal(DESKTOP_ZH.openFilesHint, "从工作区目录树中选择文件");
  assert.equal(DESKTOP_ZH.openFilesSearch, "在文件中搜索");
});
