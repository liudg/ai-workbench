import type { EventViewProps } from "./types";

/** 思考正文不进时间线。进行中的「正在思考」由时间线底部的 `LiveStatus` 画出。 */
export function ThinkingBlock({ event }: EventViewProps) {
  if (event.kind !== "thinking") return null;
  return null;
}
