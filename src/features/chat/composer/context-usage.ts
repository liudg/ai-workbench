import type { SessionEvent } from "../../../types/index.ts";

type UsageEvent = Extract<SessionEvent, { kind: "context-usage" }>;

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/** 最近一次窗口用量和最近一次本回合用量。没有事件就不显示，缺的数字不补 0。 */
export function contextUsageLine(events: readonly SessionEvent[]): string | null {
  let windowUsage: UsageEvent | null = null;
  let turnUsage: UsageEvent | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== "context-usage") continue;
    if (event.source === "get_context_usage" && !windowUsage) windowUsage = event;
    if (event.source === "partial-usage" && !turnUsage) turnUsage = event;
    if (windowUsage && turnUsage) break;
  }
  const parts: string[] = [];
  if (windowUsage) {
    const bits: string[] = [];
    const percentage = finite(windowUsage.percentage);
    const used = finite(windowUsage.used_tokens);
    const max = finite(windowUsage.max_tokens);
    if (percentage != null) bits.push(`${formatPercent(percentage)}%`);
    if (used != null && max != null) bits.push(`${used}/${max}`);
    else if (used != null) bits.push(String(used));
    const model = windowUsage.model?.trim();
    if (model) bits.push(model);
    if (bits.length > 0) parts.push(bits.join(" "));
  }
  if (turnUsage) {
    const bits: string[] = [];
    const input = finite(turnUsage.input_tokens);
    const output = finite(turnUsage.output_tokens);
    if (input != null) bits.push(`输入 ${input}`);
    if (output != null) bits.push(`输出 ${output}`);
    if (bits.length > 0) parts.push(`本回合 ${bits.join(" ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
