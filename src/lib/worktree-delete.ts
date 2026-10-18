export interface WorktreeDeletePreview {
  owned: boolean;
  dirty: boolean;
}

export interface WorktreeDeleteFlags {
  discardWorktree: boolean;
  forceWorktree: boolean;
}

/** 干净的自建工作树随任务一起删除。有未保存改动时，等用户选择。 */
export function worktreeDeleteFlags(
  action: "delete" | "keep-worktree" | "discard-worktree",
  preview: WorktreeDeletePreview | null,
): WorktreeDeleteFlags {
  if (action === "keep-worktree") return { discardWorktree: false, forceWorktree: false };
  if (action === "discard-worktree") return { discardWorktree: true, forceWorktree: true };
  if (preview?.owned && !preview.dirty) return { discardWorktree: true, forceWorktree: false };
  return { discardWorktree: false, forceWorktree: false };
}

export function worktreeDeleteIsDirty(preview: WorktreeDeletePreview | null): boolean {
  return Boolean(preview?.owned && preview.dirty);
}
