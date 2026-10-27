/** 跑完后用户还没打开的会话。记在本地，刷新还在；点进该会话就清掉。 */

export const UNREAD_FINISHED_KEY = "ai-workbench.unread-finished-sessions";

const MAX_UNREAD_FINISHED = 200;

export interface UnreadSession {
  id: string;
  status?: string | null;
}

export interface UnreadStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isFinishedStatus(status: string | null | undefined): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

export function sameUnreadIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function indexSessions(
  groups: Record<string, readonly UnreadSession[]>,
): Map<string, UnreadSession> {
  const map = new Map<string, UnreadSession>();
  for (const list of Object.values(groups)) {
    for (const session of list) map.set(session.id, session);
  }
  return map;
}

/**
 * 只在「上一帧见过、且当时还没结束」变成结束时打标。
 * 第一次见到的历史会话不打标。当前打开的会话不打标，已有标记也清掉。
 * 不改会话顺序。
 */
export function reconcileUnreadFinished(input: {
  previousSessions: Record<string, readonly UnreadSession[]>;
  nextSessions: Record<string, readonly UnreadSession[]>;
  previousUnread: readonly string[];
  visibleSessionId: string | null;
}): string[] {
  const previous = indexSessions(input.previousSessions);
  const next = indexSessions(input.nextSessions);
  const drop = new Set<string>();
  if (input.visibleSessionId) drop.add(input.visibleSessionId);
  for (const id of previous.keys()) {
    if (!next.has(id)) drop.add(id);
  }
  for (const [id, session] of next) {
    if (!isFinishedStatus(session.status)) drop.add(id);
  }

  const added: string[] = [];
  for (const [id, session] of next) {
    if (drop.has(id) || !isFinishedStatus(session.status)) continue;
    const prior = previous.get(id);
    if (!prior || isFinishedStatus(prior.status)) continue;
    added.push(id);
  }

  const kept: string[] = [];
  const seen = new Set<string>();
  for (const id of input.previousUnread) {
    if (!id || drop.has(id) || seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  for (const id of added) {
    if (seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  if (kept.length > MAX_UNREAD_FINISHED) {
    return kept.slice(kept.length - MAX_UNREAD_FINISHED);
  }
  return kept;
}

export function readUnreadFinishedIds(storage: UnreadStorage | null): string[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(UNREAD_FINISHED_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const value of parsed) {
      if (typeof value !== "string" || value.length === 0 || seen.has(value)) continue;
      seen.add(value);
      ids.push(value);
    }
    if (ids.length > MAX_UNREAD_FINISHED) return ids.slice(ids.length - MAX_UNREAD_FINISHED);
    return ids;
  } catch {
    return [];
  }
}

export function writeUnreadFinishedIds(storage: UnreadStorage | null, ids: readonly string[]): void {
  if (!storage) return;
  try {
    storage.setItem(UNREAD_FINISHED_KEY, JSON.stringify(ids));
  } catch {
    // 无痕模式或配额满时标记仍留在内存里，只是这次不能记住。
  }
}

export function browserUnreadStorage(): UnreadStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}
