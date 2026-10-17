import type { SessionEvent } from "@/types";

/**
 * 会话事件日志。聊天时间线和侧栏读同一份。
 * 按 seq 排。同一 id 或同一 seq 只留后到的那条。
 */

export function orderEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const byId = new Map<string, SessionEvent>();
  for (const event of events) byId.set(event.id, event);
  const bySeq = new Map<number, SessionEvent>();
  for (const event of byId.values()) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

/** 实时事件。乱序到达插到序号位置，同一条流覆盖原事件。 */
export function applyLiveEvent(log: readonly SessionEvent[], event: SessionEvent): SessionEvent[] {
  return orderEvents([...log, event]);
}

/**
 * 更早一页并进现有日志。页里的 id 和 seq 以这一页为准。
 * 页内没有占住的序号留下，包括夹在页中间的缺口和页之后才到的事件。
 */
export function mergeOlderPage(
  current: readonly SessionEvent[],
  page: readonly SessionEvent[],
): SessionEvent[] {
  const authoritative = orderEvents(page);
  const ids = new Set(authoritative.map((event) => event.id));
  const seqs = new Set(authoritative.map((event) => event.seq));
  const extra = orderEvents(current).filter((event) => !ids.has(event.id) && !seqs.has(event.seq));
  return orderEvents([...authoritative, ...extra]);
}

/**
 * 重连快照。远端序号为准，本地补上快照没有的缺口和晚到事件。
 * 序号没变时，本地更晚的正文留着。
 */
export function mergeEvents(
  local: readonly SessionEvent[] | undefined,
  remote: readonly SessionEvent[],
): SessionEvent[] {
  const current = local ?? [];
  const localById = new Map(current.map((event) => [event.id, event]));
  return mergeOlderPage(current, remote).map((event) => {
    const mine = localById.get(event.id);
    if (mine && mine.seq === event.seq && mine.ts >= event.ts) return mine;
    return event;
  });
}
