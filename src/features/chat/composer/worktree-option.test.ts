import assert from "node:assert/strict";
import test from "node:test";

import { showWorktreeOption, worktreeBranchMarker, worktreeCaption } from "./worktree-option.ts";

const shown = {
  draft: true,
  standalone: false,
  supportsWorktree: true,
  hasCommit: true,
};

test("worktree option appears only for a capable draft in a git project with a commit", () => {
  assert.equal(showWorktreeOption(shown), true);
  assert.equal(showWorktreeOption({ ...shown, draft: false }), false);
  assert.equal(showWorktreeOption({ ...shown, standalone: true }), false);
  assert.equal(showWorktreeOption({ ...shown, supportsWorktree: false }), false);
  assert.equal(showWorktreeOption({ ...shown, hasCommit: false }), false);
});

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
