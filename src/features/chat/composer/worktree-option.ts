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

/** 在工作树里建分支时预填的前缀，照 Codex 的 `codex/`。 */
export const WORKTREE_BRANCH_PREFIX = "aiwb/";

/** 交给项目目录时预填的分支名：前缀加标题里的英文和数字，标题没有就用任务 id 的前几位。 */
export function suggestedBranchName(title: string, taskId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const tail = slug || `task-${taskId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase()}`;
  return `${WORKTREE_BRANCH_PREFIX}${tail}`;
}
