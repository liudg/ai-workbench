import assert from "node:assert/strict";
import test from "node:test";

import { worktreeDeleteFlags, worktreeDeleteIsDirty } from "./worktree-delete.ts";

test("a clean owned worktree is removed with the session", () => {
  assert.deepEqual(worktreeDeleteFlags("delete", { owned: true, dirty: false }), {
    discardWorktree: true,
    forceWorktree: false,
  });
  assert.equal(worktreeDeleteIsDirty({ owned: true, dirty: false }), false);
});

test("unsaved worktree changes wait for an explicit choice", () => {
  const preview = { owned: true, dirty: true };
  assert.equal(worktreeDeleteIsDirty(preview), true);
  assert.deepEqual(worktreeDeleteFlags("delete", preview), {
    discardWorktree: false,
    forceWorktree: false,
  });
  assert.deepEqual(worktreeDeleteFlags("discard-worktree", preview), {
    discardWorktree: true,
    forceWorktree: true,
  });
  assert.deepEqual(worktreeDeleteFlags("keep-worktree", preview), {
    discardWorktree: false,
    forceWorktree: false,
  });
});

test("a worktree the workbench did not record stays put", () => {
  assert.deepEqual(worktreeDeleteFlags("delete", { owned: false, dirty: true }), {
    discardWorktree: false,
    forceWorktree: false,
  });
  assert.deepEqual(worktreeDeleteFlags("delete", null), {
    discardWorktree: false,
    forceWorktree: false,
  });
  assert.equal(worktreeDeleteIsDirty(null), false);
});
