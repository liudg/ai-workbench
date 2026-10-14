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

export function sidebarSessionWindow<T extends { status?: string | null }>(
  sessions: readonly T[],
  showAll: boolean,
): { ordered: T[]; visible: T[]; overflow: boolean } {
  const ordered = pinActiveSessions(sessions);
  const overflow = ordered.length > SESSION_PREVIEW_LIMIT;
  const visible = !overflow || showAll ? ordered : ordered.slice(0, SESSION_PREVIEW_LIMIT);
  return { ordered, visible, overflow };
}
