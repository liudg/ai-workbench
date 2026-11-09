import type { SessionEvent } from "../../../types/index.ts";

export type OfferState = "pending" | "expired" | "accepted" | "declined";

type OfferEvent = Extract<SessionEvent, { kind: "subtask-offer" }>;

export function offerState(event: OfferEvent, now: number): OfferState {
  if (event.resolution) return event.resolution.kind;
  if (event.expires_at !== undefined && now > event.expires_at) return "expired";
  return "pending";
}

/** 卡片上的字：标题、两个按钮、选过之后的结果。 */
export function offerLabels(initiation: OfferEvent["initiation"], link: OfferEvent["link"]) {
  const noun = link === "child" ? "子任务" : "新会话";
  return initiation === "offer"
    ? { title: `另开${noun}？`, accept: "另开", decline: "就在这做", declined: "在这里做" }
    : { title: `建议另开${noun}`, accept: "开始", decline: "不用了", declined: "已忽略" };
}
