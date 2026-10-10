import type { SessionEvent, SessionStatus } from "@/types";

/**
 * 时间线以事件日志里最后一次状态为准。
 * 会话列表刷新可能晚一拍，折叠和「正在处理」要跟这一轮结束对齐。
 */
export function timelineStatus(
  events: readonly SessionEvent[],
  fallback: SessionStatus,
): SessionStatus {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === "status-changed") return event.status;
  }
  return fallback;
}

/**
 * 思考和工具详情在本轮还在回答、或停在提问时展开。
 * 整轮结束（完成 / 失败 / 停止）后默认折叠。
 * 不按「这一组工具刚结束」折叠，否则回答还在继续时详情会提前收起。
 */
export function turnDetailsOpen(
  events: readonly SessionEvent[],
  status: SessionStatus,
  eventIndex: number,
): boolean {
  if (status !== "running" && status !== "needs-input") return false;
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "user-message") {
      start = i;
      break;
    }
  }
  return eventIndex >= start;
}
