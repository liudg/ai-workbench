/** 工作台本地项目置顶。不写 Agent，重开后仍用这份 id 列表。 */

import { browserPinStorage, type PinStorage } from "./pinned-sessions.ts";

export const PINNED_PROJECTS_KEY = "ai-workbench.pinned-projects";

export { browserPinStorage, type PinStorage };

export function readPinnedProjectIds(storage: PinStorage | null): string[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(PINNED_PROJECTS_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

export function writePinnedProjectIds(ids: readonly string[], storage: PinStorage | null): void {
  if (!storage) return;
  try {
    storage.setItem(PINNED_PROJECTS_KEY, JSON.stringify(ids));
  } catch {
    // 配额满时这次置顶仍然生效，只是重开后记不住。
  }
}

/** 再点一次取消。新置顶接在后面，已有顺序不动。 */
export function togglePinnedProjectId(ids: readonly string[], projectId: string): string[] {
  if (projectId.length === 0) return ids.slice();
  if (ids.includes(projectId)) return ids.filter((id) => id !== projectId);
  return [...ids, projectId];
}
