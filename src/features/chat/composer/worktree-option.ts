/**
 * 工作树会话的分支标记。
 * 有自己的分支就显示分支名。分离头指针显示创建时基于的分支，没有分支名时显示 7 位提交号。
 */
export function worktreeBranchMarker(input: {
  liveBranch?: string | null;
  base?: string | null;
  sha?: string | null;
}): string | null {
  const live = input.liveBranch?.trim() ?? "";
  if (live && live !== "HEAD") return live;
  const base = input.base?.trim() ?? "";
  if (base && base !== "HEAD") return `基于 ${base}`;
  const sha = (input.sha ?? "").trim().toLowerCase();
  if (/^[0-9a-f]{7,}$/.test(sha)) return sha.slice(0, 7);
  return null;
}

/** 会话已经在工作树里时，用路径末两段标出是哪一棵。完整路径放在 title。 */
export function worktreeCaption(workdir: string): string {
  const parts = workdir.replace(/\\/g, "/").split("/").filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return tail ? `工作树 ${tail}` : "工作树";
}
