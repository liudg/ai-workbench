import type { SessionEvent } from "@/types";

/** 最近一条目标事件。objective 为空表示目标已清除。 */
export function activeGoal(events: readonly SessionEvent[]): { objective: string; status: string } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== "goal") continue;
    const objective = event.objective?.trim() ?? "";
    if (!objective) return null;
    return { objective, status: event.status?.trim() || "active" };
  }
  return null;
}
