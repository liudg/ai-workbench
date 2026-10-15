import type { SessionEvent, SessionStatus } from "../../../types/index.ts";
import { promptInteractive } from "./prompt-values.ts";

/**
 * 当前要浮出的提问。只认最后一条还没回答的 prompt，而且它得是带题目的 questions。
 * 后面如果先挡着别的提问，就不浮旧题。会话已停止或失败时不浮。
 */
export function pendingQuestionEvent(
  events: readonly SessionEvent[],
  status: SessionStatus,
): Extract<SessionEvent, { kind: "prompt" }> | null {
  if (!promptInteractive(null, status)) return null;
  const resolved = new Set(
    events.flatMap((event) => (event.kind === "prompt-resolved" ? [event.prompt_id] : [])),
  );
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== "prompt" || resolved.has(event.prompt_id)) continue;
    if (event.prompt_kind !== "questions" || event.questions.length === 0) return null;
    return event;
  }
  return null;
}
