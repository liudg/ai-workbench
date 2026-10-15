import type { EventViewProps } from "./types";

/** 思考正文不进时间线。进行中的「正在思考」由活动流末行单独画出。 */
export function ThinkingBlock({ event }: EventViewProps) {
  if (event.kind !== "thinking") return null;
  return null;
}
