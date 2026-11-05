import assert from "node:assert/strict";
import test from "node:test";

import { suggestedBranchName, worktreeBranchMarker, worktreeCaption } from "./worktree-option.ts";

test("a detached worktree marker names the base branch or a short commit", () => {
  assert.equal(worktreeBranchMarker({ liveBranch: "worktree-wt-abcd1234" }), "worktree-wt-abcd1234");
  assert.equal(worktreeBranchMarker({ liveBranch: "HEAD", base: "main" }), "基于 main");
  assert.equal(worktreeBranchMarker({ liveBranch: null, base: "main", sha: "abcdef1234567890" }), "基于 main");
  assert.equal(worktreeBranchMarker({ liveBranch: null, sha: "ABCDEF1234567890" }), "abcdef1");
  assert.equal(worktreeBranchMarker({ liveBranch: "HEAD" }), null);
  assert.equal(worktreeBranchMarker({ liveBranch: null, base: "HEAD", sha: "abc" }), null);
});

test("a recorded worktree session still shows its marker", () => {
  const workdir = "/home/me/.codex/worktrees/a1b2/demo/src";
  assert.equal(worktreeCaption(workdir), "工作树 demo/src");
  assert.equal(
    worktreeBranchMarker({ liveBranch: null, base: "main", sha: "abcdef1234567890" }),
    "基于 main",
  );
  assert.equal(
    worktreeBranchMarker({ liveBranch: "HEAD", base: "main", sha: "abcdef1234567890" }),
    "基于 main",
  );
});

test("worktree caption uses the last two path segments", () => {
  assert.equal(worktreeCaption("/home/me/.codex/worktrees/a1b2/demo"), "工作树 a1b2/demo");
  assert.equal(worktreeCaption("C:\\repo\\.claude\\worktrees\\wt-abcd1234"), "工作树 worktrees/wt-abcd1234");
  assert.equal(worktreeCaption(""), "工作树");
});

test("hand-off branch names come from the title or the task id", () => {
  assert.equal(suggestedBranchName("Fix login redirect!", "abc"), "aiwb/fix-login-redirect");
  assert.equal(suggestedBranchName("修登录 bug 42", "abc"), "aiwb/bug-42");
  assert.equal(suggestedBranchName("修登录", "0f3a9c21-77"), "aiwb/task-0f3a9c21");
});
