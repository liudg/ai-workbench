import type { SessionEvent } from "@/types";

export interface GoalSnapshot {
  objective: string;
  status: string;
  tokenBudget: number | null;
  tokensUsed: number | null;
  timeUsedSeconds: number | null;
}

/** 最近一条目标事件。objective 为空表示目标已清除。 */
export function activeGoal(events: readonly SessionEvent[]): GoalSnapshot | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== "goal") continue;
    const objective = event.objective?.trim() ?? "";
    if (!objective) return null;
    return {
      objective,
      status: event.status?.trim() || "active",
      tokenBudget: finiteNumber(event.token_budget),
      tokensUsed: finiteNumber(event.tokens_used),
      timeUsedSeconds: finiteNumber(event.time_used_seconds),
    };
  }
  return null;
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
