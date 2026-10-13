import type { SessionEvent } from "../../../types/index.ts";

export type ComposerMode = "plan" | "goal" | "default";

export function collaborationMode(events: readonly SessionEvent[]): "plan" | "default" {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === "collaboration-mode") {
      return event.mode === "plan" ? "plan" : "default";
    }
  }
  return "default";
}

/**
 * 计划和目标不能同时占着作曲栏。
 * 本地草稿优先。两边都有服务端状态时，后发生的那条赢。
 */
export function exclusiveComposerMode(
  events: readonly SessionEvent[],
  goal: { draft: boolean; live: boolean },
): ComposerMode {
  const plan = collaborationMode(events) === "plan";
  if (goal.draft) return "goal";
  if (goal.live && plan) return newerMode(events);
  if (goal.live) return "goal";
  return plan ? "plan" : "default";
}

function newerMode(events: readonly SessionEvent[]): ComposerMode {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === "collaboration-mode") return event.mode === "plan" ? "plan" : "goal";
    if (event.kind === "goal") return event.objective?.trim() ? "goal" : "plan";
  }
  return "goal";
}
