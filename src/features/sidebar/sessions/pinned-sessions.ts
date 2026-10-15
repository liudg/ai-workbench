/** 工作台本地置顶。不写 Agent，重开后仍用这份 id 列表。 */

export const PINNED_SESSIONS_KEY = "ai-workbench.pinned-sessions";

export interface PinStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readPinnedSessionIds(storage: PinStorage | null): string[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(PINNED_SESSIONS_KEY);
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

export function writePinnedSessionIds(ids: readonly string[], storage: PinStorage | null): void {
  if (!storage) return;
  try {
    storage.setItem(PINNED_SESSIONS_KEY, JSON.stringify(ids));
  } catch {
    // 配额满时这次置顶仍然生效，只是重开后记不住。
  }
}

/** 再点一次取消。新置顶排到最前。 */
export function togglePinnedSessionId(ids: readonly string[], sessionId: string): string[] {
  if (sessionId.length === 0) return ids.slice();
  if (ids.includes(sessionId)) return ids.filter((id) => id !== sessionId);
  return [sessionId, ...ids];
}

export function browserPinStorage(): PinStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}
