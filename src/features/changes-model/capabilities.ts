import type { ChangeCapabilities } from "../../types.ts";

/** 目录还没到时先按事件显示，避免变更卡在能力表加载前被藏掉。 */
export function showsFileChanges(changes: ChangeCapabilities | undefined): boolean {
  if (!changes) return true;
  return changes.per_file_patch || changes.turn_diff;
}

export function showsTurnScope(changes: ChangeCapabilities | undefined): boolean {
  return changes?.turn_diff !== false;
}

export function showsGitScopes(changes: ChangeCapabilities | undefined): boolean {
  return changes?.git_scopes !== false;
}
