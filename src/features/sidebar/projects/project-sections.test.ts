import assert from "node:assert/strict";
import { test } from "node:test";

import { splitPinnedProjects } from "./project-sections.ts";

const projects = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

test("置顶沿用侧栏原有顺序，未置顶留在项目区", () => {
  const sections = splitPinnedProjects(projects, ["c", "a"]);
  assert.deepEqual(
    sections.pinned.map((project) => project.id),
    ["a", "c"],
  );
  assert.deepEqual(
    sections.unpinned.map((project) => project.id),
    ["b", "d"],
  );
});

test("没有置顶时不产生置顶区", () => {
  const sections = splitPinnedProjects(projects, []);
  assert.deepEqual(sections.pinned, []);
  assert.deepEqual(sections.unpinned, projects);
});

test("未知 id 和空 id 不制造空行", () => {
  const sections = splitPinnedProjects(projects, ["", "missing", "b"]);
  assert.deepEqual(
    sections.pinned.map((project) => project.id),
    ["b"],
  );
  assert.deepEqual(
    sections.unpinned.map((project) => project.id),
    ["a", "c", "d"],
  );
});
