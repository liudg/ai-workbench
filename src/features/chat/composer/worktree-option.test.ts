import assert from "node:assert/strict";
import test from "node:test";

import { showWorktreeOption, worktreeCaption } from "./worktree-option.ts";

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

test("worktree caption uses the last two path segments", () => {
  assert.equal(worktreeCaption("/home/me/.codex/worktrees/a1b2/demo"), "工作树 a1b2/demo");
  assert.equal(worktreeCaption("C:\\repo\\.claude\\worktrees\\wt-abcd1234"), "工作树 worktrees/wt-abcd1234");
  assert.equal(worktreeCaption(""), "工作树");
});
