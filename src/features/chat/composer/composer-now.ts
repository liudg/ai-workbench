import type { ComposerSubmit } from "./composer-submit.ts";

/**
 * Ctrl+Enter。
 * 输入框有字、附件或文本片时直接送出：运行中由后端引导进当前回合，不进队列，也不改 followUpQueueMode。
 * 输入框空、队列有条目时，按队列顺序逐条引导，不把几条并成一条。
 * 提问还占着输入时走原来的回答，不刷队列。
 */
export type CtrlEnterAction =
  | { type: "submit-now" }
  | { type: "flush-queue" }
  | { type: "plain-submit" }
  | { type: "noop" };

export function composerCtrlEnter(input: {
  text: string;
  fileCount: number;
  snippetCount: number;
  queueCount: number;
  editing: boolean;
  /** 审批不是提问。审批卡自己的快捷键在输入框里不生效。 */
  pendingQuestion: boolean;
  composerLocked: boolean;
}): CtrlEnterAction {
  const hasText = input.text.trim().length > 0;
  if (input.pendingQuestion) {
    return hasText ? { type: "plain-submit" } : { type: "noop" };
  }
  if (input.composerLocked) return { type: "noop" };
  const hasComposer = hasText || input.fileCount > 0 || input.snippetCount > 0;
  if (hasComposer) return { type: "submit-now" };
  if (input.editing) return { type: "noop" };
  if (input.queueCount > 0) return { type: "flush-queue" };
  return { type: "noop" };
}

/**
 * 整队送出的 id。顺序就是队列顺序。
 * 不合并：引导一次只处理一条，正文和图片都挂在这一条上。
 * Codex 的 `turn/steer`、Claude 写入 stdin 都是这个粒度。
 */
export function queueFlushIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 有内容的 Ctrl+Enter 走哪条通道。
 * 草稿会话还没在跑，仍用普通发送。
 * 正在改队列里的一条时，不写回队列，改成直接送出。
 */
export function submitDelivery(input: {
  now: boolean;
  holdUntilAccepted: boolean;
  decision: ComposerSubmit["type"];
}): "queue-edit" | "send" | "send-now" | "other" {
  if (input.decision === "update-queue") {
    return input.now ? "send-now" : "queue-edit";
  }
  if (
    input.decision === "send-text" ||
    input.decision === "send-images" ||
    input.decision === "plan-message"
  ) {
    return input.now && !input.holdUntilAccepted ? "send-now" : "send";
  }
  return "other";
}
