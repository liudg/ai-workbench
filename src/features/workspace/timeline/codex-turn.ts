import type { SessionEvent } from "../../../types.ts";

import { filesChangedLabel, parseUnifiedDiff } from "../changes/model.ts";

export function collaborationMode(events: readonly SessionEvent[]): "plan" | "default" {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === "collaboration-mode") {
      return event.mode === "plan" ? "plan" : "default";
    }
  }
  return "default";
}

export function diffStats(diff: string): { files: number; added: number; removed: number } {
  const files = parseUnifiedDiff(diff);
  return {
    files: files.length,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  };
}

export function diffSummary(diff: string): string {
  const stats = diffStats(diff);
  return `${filesChangedLabel(stats.files)}  +${stats.added}  -${stats.removed}`;
}

/** 退出审查后的 agentMessage 与 findings 原文相同，时间线只留卡片。 */
export function isReviewDuplicate(events: readonly SessionEvent[], index: number): boolean {
  const event = events[index];
  if (event.kind !== "agent-message") return false;
  const text = event.text.trim();
  if (!text) return false;
  return events.some((other, otherIndex) => {
    if (otherIndex === index || other.kind !== "review-findings") return false;
    if (other.raw.trim() !== text) return false;
    const [start, end] = index < otherIndex ? [index, otherIndex] : [otherIndex, index];
    for (let cursor = start + 1; cursor < end; cursor += 1) {
      if (events[cursor].kind === "user-message") return false;
    }
    return true;
  });
}
