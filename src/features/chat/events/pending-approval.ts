import type { PromptOption, SessionEvent, SessionStatus } from "../../../types/index.ts";
import { promptInteractive } from "./prompt-values.ts";

export type ApprovalPrompt = Extract<SessionEvent, { kind: "prompt" }>;

export interface ApprovalSlots {
  primary?: PromptOption;
  deny?: PromptOption;
  leading?: PromptOption;
  scoped?: PromptOption;
}

/**
 * 最后一条还没回答的 prompt 是审批时，把它放到输入框上方。
 * 更新的提问、选择或自由文本优先，旧审批先排队。
 */
export function pendingApprovalEvent(
  events: readonly SessionEvent[],
  status: SessionStatus,
): ApprovalPrompt | null {
  if (!promptInteractive(null, status)) return null;
  const resolved = new Set(
    events.flatMap((event) => (event.kind === "prompt-resolved" ? [event.prompt_id] : [])),
  );
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== "prompt" || resolved.has(event.prompt_id)) continue;
    if (event.prompt_kind !== "approval") return null;
    return event;
  }
  return null;
}

/** 只按适配器给的 slot 摆按钮。没有 slot 的旧事件仍是前两个选项。 */
export function approvalSlots(options: readonly PromptOption[]): ApprovalSlots {
  const slotted = options.some((option) => option.slot);
  if (!slotted) {
    return { primary: options[0], deny: options[1] };
  }
  return {
    primary: options.find((option) => option.slot === "primary"),
    deny: options.find((option) => option.slot === "deny"),
    leading: options.find((option) => option.slot === "leading"),
    scoped: options.find((option) => option.slot === "scoped"),
  };
}
