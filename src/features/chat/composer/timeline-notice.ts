import type { SessionEvent } from "../../../types/event.ts";

/** 时间线最后一条不是状态的事件就是这句报错。打开会话时几处同时要不到句柄，作曲栏不再重复。 */
export function shownInTimeline(events: SessionEvent[], text: string): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === "status-changed") continue;
    return event.kind === "error" && event.message.trim() === text.trim();
  }
  return false;
}
