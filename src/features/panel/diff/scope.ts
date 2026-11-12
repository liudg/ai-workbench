import type { ChangeCapabilities } from "../../../types/index.ts";
import type { FileChange } from "../../changes-model/index.ts";

export interface ScopeChoice {
  id: string;
  label: string;
  source: string;
}

export interface DiffScopeItem {
  id: string;
  label: string;
  source: string;
}

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
    items.push({ id: scope.id, label: scope.label, source: scope.source });
  }
  return items;
}

/** 「上一轮」用事件里的文件；其它范围用 diff_for_scope 的结果。 */
export function filesForScope(
  item: { source: string } | undefined,
  turnFiles: readonly FileChange[],
  loaded: readonly FileChange[] | null,
): FileChange[] {
  if (!item || item.source === "turn") return turnFiles.slice();
  return loaded ? loaded.slice() : [];
}
