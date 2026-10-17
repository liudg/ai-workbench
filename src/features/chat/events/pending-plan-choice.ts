import type { SessionEvent, SessionStatus } from "../../../types/index.ts";
import { promptInteractive } from "./prompt-values.ts";

export type PlanChoicePrompt = Extract<SessionEvent, { kind: "prompt" }>;

/** 带 slot 的选择放到输入框上方。返回 boolean，避免在时间线里收窄掉 prompt。 */
export function choiceHasSlot(event: SessionEvent): boolean {
  return (
    event.kind === "prompt" &&
    event.prompt_kind === "choice" &&
    event.options.some((option) => Boolean(option.slot))
  );
}

/**
 * 带 slot 的选择是待确认面板。计划实施用 primary / leading / deny。
 * 没有 slot 的选择仍留在时间线里。
 */
export function isPinnedChoice(event: SessionEvent): event is PlanChoicePrompt {
  return choiceHasSlot(event);
}

/**
 * 最后一条还没回答的 prompt 是带 slot 的选择时，把它放到输入框上方。
 * 更新的提问或审批优先，旧的计划确认先排队。会话已停止或失败时不浮。
 */
export function pendingPlanChoice(
  events: readonly SessionEvent[],
  status: SessionStatus,
): PlanChoicePrompt | null {
  if (!promptInteractive(null, status)) return null;
  const resolved = new Set(
    events.flatMap((event) => (event.kind === "prompt-resolved" ? [event.prompt_id] : [])),
  );
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== "prompt" || resolved.has(event.prompt_id)) continue;
    if (!isPinnedChoice(event)) return null;
    return event;
  }
  return null;
}
