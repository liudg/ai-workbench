import { isPinnedSession } from "./session-status.ts";

/** 折叠时先露出的条数。和原先的「展开显示」一致。 */
export const SESSION_PREVIEW_LIMIT = 8;

export function pinActiveSessions<T extends { status?: string | null }>(
  sessions: readonly T[],
): T[] {
  const active: T[] = [];
  const rest: T[] = [];
  for (const session of sessions) {
    if (isPinnedSession(session.status)) active.push(session);
    else rest.push(session);
  }
  if (active.length === 0 || rest.length === 0) return sessions.slice();
  return active.concat(rest);
}

/** 用户置顶在最前，最近置顶排得更靠前。剩下的仍把运行中和等待排到前面。 */
export function orderSidebarSessions<T extends { id: string; status?: string | null }>(
  sessions: readonly T[],
  pinnedIds: readonly string[],
): T[] {
  if (pinnedIds.length === 0) return pinActiveSessions(sessions);
  const rank = new Map<string, number>();
  pinnedIds.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const session of sessions) {
    if (rank.has(session.id)) pinned.push(session);
    else rest.push(session);
  }
  pinned.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return pinned.concat(pinActiveSessions(rest));
}

export function sidebarSessionWindow<T extends { id: string; status?: string | null }>(
  sessions: readonly T[],
  showAll: boolean,
  pinnedIds: readonly string[] = [],
): { ordered: T[]; visible: T[]; overflow: boolean } {
  const ordered = orderSidebarSessions(sessions, pinnedIds);
  const overflow = ordered.length > SESSION_PREVIEW_LIMIT;
  const visible = !overflow || showAll ? ordered : ordered.slice(0, SESSION_PREVIEW_LIMIT);
  return { ordered, visible, overflow };
}
