import { isPinnedSession } from "./session-status.ts";

/** 折叠时先露出的条数。每次「展开显示」再多露出同样的条数。 */
export const SESSION_PREVIEW_LIMIT = 8;

/** 再点一次「展开显示」时的条数上限。 */
export function revealMoreSessions(visibleLimit: number): number {
  const current = normalizeVisibleLimit(visibleLimit);
  return current + SESSION_PREVIEW_LIMIT;
}

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
  visibleLimit: number,
  pinnedIds: readonly string[] = [],
): { ordered: T[]; visible: T[]; canRevealMore: boolean; canCollapse: boolean } {
  const ordered = orderSidebarSessions(sessions, pinnedIds);
  const limit = normalizeVisibleLimit(visibleLimit);
  const visible = ordered.slice(0, Math.min(ordered.length, limit));
  return {
    ordered,
    visible,
    canRevealMore: ordered.length > visible.length,
    canCollapse: visible.length > SESSION_PREVIEW_LIMIT,
  };
}

function normalizeVisibleLimit(visibleLimit: number): number {
  if (!Number.isFinite(visibleLimit)) return SESSION_PREVIEW_LIMIT;
  return Math.max(SESSION_PREVIEW_LIMIT, Math.trunc(visibleLimit));
}
