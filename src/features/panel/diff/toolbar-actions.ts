/** 差异工具栏右侧图标，从左到右跟 Codex 桌面截图一致。 */
export const DIFF_TOOLBAR_ICON_IDS = [
  "options",
  "jump",
  "refresh",
  "wrap",
  "expand",
  "layout",
  "files",
] as const;

export type DiffToolbarIconId = (typeof DIFF_TOOLBAR_ICON_IDS)[number];

const GIT_WORKING_TREE_SCOPE_IDS = new Set(["uncommitted", "staged", "unstaged"]);

/** 当前范围是否为 Git 工作树范围（未提交 / 已暂存 / 未暂存），而非历史回合静态补丁。 */
export function isGitWorkingTreeScope(
  scope: string,
  scopes: readonly { id: string; source: string }[],
): boolean {
  if (scopes.length === 0) return false;
  const active = scopes.find((item) => item.id === scope) ?? scopes[0];
  if (!active || active.source === "turn") return false;
  return active.source === "git" || GIT_WORKING_TREE_SCOPE_IDS.has(active.id);
}
