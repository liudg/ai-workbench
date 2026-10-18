/** 新建会话时，要不要给出「在新的工作树中运行」。只看能力、草稿和仓库，不看 Agent 名字。 */
export function showWorktreeOption(input: {
  draft: boolean;
  standalone: boolean;
  supportsWorktree: boolean;
  hasCommit: boolean;
}): boolean {
  return input.draft && !input.standalone && input.supportsWorktree && input.hasCommit;
}

/** 会话已经在工作树里时，用路径末两段标出是哪一棵。完整路径放在 title。 */
export function worktreeCaption(workdir: string): string {
  const parts = workdir.replace(/\\/g, "/").split("/").filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return tail ? `工作树 ${tail}` : "工作树";
}
