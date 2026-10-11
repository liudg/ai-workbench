import type { SessionEvent } from "../../../types.ts";

import { CODEX_DESKTOP } from "../codex-desktop.ts";

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
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      const path = line.slice(6).trim();
      if (path && path !== "/dev/null") files.add(path);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return { files: files.size, added, removed };
}

export function diffSummary(diff: string): string {
  const stats = diffStats(diff);
  const files =
    stats.files === 1
      ? CODEX_DESKTOP.fileChanged
      : CODEX_DESKTOP.filesChanged.replace("{count}", String(stats.files));
  return `${files}  +${stats.added}  −${stats.removed}`;
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
