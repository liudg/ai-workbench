import type { SessionEvent } from "@/types";

/** 新会话还没建，计划模式和目标先画成事件，作曲栏照常认出来。 */
export function intentEvents(
  sessionId: string,
  input: { plan: boolean; goal: string | null; goalStatus: "paused" | "active" | null },
): SessionEvent[] {
  const events: SessionEvent[] = [];
  if (input.plan) {
    events.push({ id: `${sessionId}:plan`, session_id: sessionId, seq: 1, ts: 0, kind: "collaboration-mode", mode: "plan" });
  }
  const goal = input.goal?.trim();
  if (goal) {
    events.push({
      id: `${sessionId}:goal`,
      session_id: sessionId,
      seq: 2,
      ts: 0,
      kind: "goal",
      objective: goal,
      status: input.goalStatus ?? "active",
    });
  }
  return events;
}
