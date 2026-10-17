import assert from "node:assert/strict";
import { test } from "node:test";

import {
  branchNameError,
  branchSearchPlaceholder,
  filterBranchNames,
  gitBranchChipLabel,
  uncommittedFileLabel,
} from "./git-branch.ts";

test("branch search placeholder uses the project name", () => {
  assert.equal(branchSearchPlaceholder("CSGO"), "搜索CSGO分支");
  assert.equal(branchSearchPlaceholder(" 笔记 "), "搜索笔记分支");
});

test("uncommitted subtitle is omitted without a positive count", () => {
  assert.equal(uncommittedFileLabel(135), "未提交：135 个文件");
  assert.equal(uncommittedFileLabel(0), null);
  assert.equal(uncommittedFileLabel(null), null);
  assert.equal(uncommittedFileLabel(undefined), null);
  assert.equal(uncommittedFileLabel(Number.NaN), null);
});

test("branch filter keeps order and ignores case", () => {
  assert.deepEqual(filterBranchNames(["master", "Topic", "feature/next"], "t"), [
    "master",
    "Topic",
    "feature/next",
  ]);
  assert.deepEqual(filterBranchNames(["master", "Topic", "feature/next"], "TOP"), ["Topic"]);
  assert.deepEqual(filterBranchNames(["master"], "zzz"), []);
});

test("detached head chip says HEAD", () => {
  assert.equal(gitBranchChipLabel("master"), "master");
  assert.equal(gitBranchChipLabel(null), "HEAD");
  assert.equal(gitBranchChipLabel("  "), "HEAD");
  assert.equal(gitBranchChipLabel("HEAD"), "HEAD");
});

test("branch name errors match the short ref rules", () => {
  assert.equal(branchNameError("  "), "请输入分支名");
  assert.equal(branchNameError("master"), null);
  assert.equal(branchNameError(" feature/next "), null);
  assert.equal(branchNameError("功能"), null);
  for (const name of ["foo..bar", "-wip", "foo.lock", "HEAD", "head", "foo bar", "@"]) {
    assert.equal(branchNameError(name), "分支名无效", name);
  }
});
