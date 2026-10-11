import type { ChangeCapabilities } from "../../../types.ts";
import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import type { FileChange } from "../../changes-model/diff-parse.ts";

export interface ScopeChoice {
  id: string;
  label: string;
  source: string;
}

export interface DiffScopeItem {
  id: string;
  label: string;
  submenu: boolean;
  source: string;
}

/** 已提交、分支在参考菜单里有尖角，子菜单没有打开。 */
const CLOSED_GIT_SCOPES: DiffScopeItem[] = [
  { id: "committed", label: DESKTOP_ZH.diffCommitted, submenu: true, source: "git" },
  { id: "branch", label: DESKTOP_ZH.diffBranch, submenu: true, source: "git" },
];

export function diffScopeMenu(
  provided: readonly ScopeChoice[],
  changes: ChangeCapabilities | undefined,
): DiffScopeItem[] {
  if (provided.length === 0) return [];
  const turn = changes?.turn_diff !== false;
  const git = changes?.git_scopes !== false;
  const items: DiffScopeItem[] = [];
  for (const scope of provided) {
    if (scope.source === "turn" && !turn) continue;
    if (scope.source !== "turn" && !git) continue;
    items.push({ id: scope.id, label: scope.label, submenu: false, source: scope.source });
  }
  if (git) items.push(...CLOSED_GIT_SCOPES);
  return items;
}

/** 「上一轮」用事件里的文件；其它范围用 diff_for_scope 的结果。 */
export function filesForScope(
  item: { source: string; submenu: boolean } | undefined,
  turnFiles: readonly FileChange[],
  loaded: readonly FileChange[] | null,
): FileChange[] {
  if (!item || item.submenu || item.source === "turn") return turnFiles.slice();
  return loaded ? loaded.slice() : [];
}
