import type { Session } from "../types/index.ts";

export const MISSING_SESSION = "会话不存在或已结束";

export function isMissingSessionError(error: unknown): boolean {
  return String(error).includes("会话不存在");
}

/** 红条只留给真正的失败。会话不存在不走这条。 */
export function visibleBanner(lastError: string | null): string | null {
  if (isMissingSessionError(lastError)) return null;
  return lastError;
}

/** 打开完成后又有事件，说明刚才那句「不存在」是抢跑。时间线已经在了，横幅拿掉。 */
export function clearMissingSessionBanner(
  lastError: string | null,
  events: { kind: string }[],
): string | null {
  if (isMissingSessionError(lastError) && events.length > 0) return null;
  return lastError;
}

/** 选中的会话确实不在了：清掉选中，调用方不要再弹红条。 */
export function deselectSession(
  active: Record<string, string>,
  sessionId: string,
): Record<string, string> {
  const next = { ...active };
  for (const [projectId, id] of Object.entries(next)) {
    if (id === sessionId) delete next[projectId];
  }
  return next;
}

export function withoutSession(
  groups: Record<string, Session[]>,
  sessionId: string,
): Record<string, Session[]> {
  const next: Record<string, Session[]> = {};
  for (const [projectId, list] of Object.entries(groups)) {
    next[projectId] = list.filter((session) => session.id !== sessionId);
  }
  return next;
}
