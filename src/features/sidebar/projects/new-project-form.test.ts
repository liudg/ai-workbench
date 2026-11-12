import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activeNewProjectFields,
  applyPickedFolder,
  initialNewProjectForm,
  selectProjectSource,
  updateProjectName,
} from "./new-project-form.ts";

test("re-picking an imported folder updates default placeholder without locking stale folder name", () => {
  let state = initialNewProjectForm("import");
  state = applyPickedFolder(state, "E:\\repos\\alpha-service");

  let view = activeNewProjectFields(state);
  assert.equal(view.dir, "E:\\repos\\alpha-service");
  assert.equal(view.name, "");
  assert.equal(view.placeholder, "默认使用 alpha-service");
  assert.equal(view.valid, true);

  state = applyPickedFolder(state, "E:\\repos\\beta-worker");
  view = activeNewProjectFields(state);
  assert.equal(view.dir, "E:\\repos\\beta-worker");
  assert.equal(view.name, "");
  assert.equal(view.placeholder, "默认使用 beta-worker");
});

test("switching between import and create tabs isolates directories, names, and clears errors", () => {
  let state = initialNewProjectForm("import");
  state = applyPickedFolder(state, "/workspace/existing-app");
  state = updateProjectName(state, "Existing Alias");
  state = { ...state, lastError: "目录已存在" };

  state = selectProjectSource(state, "create");
  assert.equal(state.lastError, null);
  let createView = activeNewProjectFields(state);
  assert.equal(createView.dir, "");
  assert.equal(createView.name, "");
  assert.equal(createView.valid, false);

  state = applyPickedFolder(state, "/workspace/projects");
  state = updateProjectName(state, "new-service");
  createView = activeNewProjectFields(state);
  assert.equal(createView.dir, "/workspace/projects");
  assert.equal(createView.name, "new-service");
  assert.equal(createView.valid, true);

  state = selectProjectSource(state, "import");
  const importView = activeNewProjectFields(state);
  assert.equal(importView.dir, "/workspace/existing-app");
  assert.equal(importView.name, "Existing Alias");
  assert.equal(importView.valid, true);
});
