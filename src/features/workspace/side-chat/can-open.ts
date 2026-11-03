// 主对话现在能不能开侧边聊天。

import type { TaskEntry } from "@/features/tasks";
import type { AgentProfile, SessionEvent } from "@/types";

/**
 * 和 daemon `tasks.openSide` 同一个条件：Agent 能分出侧边聊天，主对话现在这段有原生会话、
 * 说过话，换 Agent 带来的前文也交出去了。`events` 是现在这段的时间线。
 */
export function canOpenSideChat(
  task: TaskEntry,
  profile: AgentProfile | undefined,
  events: readonly SessionEvent[],
): boolean {
  const current = task.sessions[task.sessions.length - 1];
  if (!profile?.capabilities.supports_side_chat || !current?.nativeId) return false;
  let spoken = false;
  for (const event of events) {
    if (event.kind === "handoff" && !event.delivered) return false;
    if (event.kind === "user-message") spoken = true;
  }
  return spoken;
}
