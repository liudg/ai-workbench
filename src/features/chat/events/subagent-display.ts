import type { SessionEvent, SubagentStatus } from "../../../types/index.ts";
import { formatTokens } from "../../../shared/format/tokens.ts";

/**
 * Agent 自带子 Agent 的展示数据。卡片和步骤都来自适配器写的 `subagent` / `subagent-step`，
 * 这里不看 Agent 种类。分组摘要照 t3code
 * `packages/client-runtime/src/state/subagent-display.ts` 的 `subagentGroupSummary` / `summarizeSubagentStatuses`。
 */

export type SubagentEvent = Extract<SessionEvent, { kind: "subagent" }>;

const STATUS_ORDER: readonly SubagentStatus[] = ["running", "failed", "stopped", "completed"];

export const SUBAGENT_STATUS_LABELS: Record<SubagentStatus, string> = {
  running: "运行中",
  completed: "完成",
  failed: "失败",
  stopped: "已停止",
};

/** 每个子 Agent 自己的步骤，按出现顺序。步骤沿用外层事件的 id 和时间。 */
export function subagentSteps(events: readonly SessionEvent[]): ReadonlyMap<string, SessionEvent[]> {
  const steps = new Map<string, SessionEvent[]>();
  for (const event of events) {
    if (event.kind !== "subagent-step") continue;
    const step = { ...event.step, id: event.id, session_id: event.session_id, seq: event.seq, ts: event.ts } as SessionEvent;
    const list = steps.get(event.subagent_id);
    if (list) list.push(step);
    else steps.set(event.subagent_id, [step]);
  }
  return steps;
}

/** 卡片标题。没有描述时用类型，再没有就叫「子 Agent」。 */
export function subagentTitle(card: SubagentEvent): string {
  return card.title.trim() || card.agent_type?.trim() || "子 Agent";
}

/** 标题后面那串：类型（标题已经是类型时不重复）、模型、强度。 */
export function subagentMeta(card: SubagentEvent): string {
  const parts = [card.agent_type, card.model, card.effort]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0);
  const title = subagentTitle(card);
  return parts.filter((part, index) => !(index === 0 && part === title)).join(" · ");
}

/** 用时：原生报的为准，否则从开始算到结束（还在跑就算到 `now`）。没有开始时间就是 null。 */
export function subagentElapsed(card: SubagentEvent, now: number): number | null {
  if (card.duration_ms != null) return card.duration_ms;
  if (card.started_at == null) return null;
  const end = card.status === "running" ? now : (card.ended_at ?? null);
  return end == null ? null : Math.max(0, end - card.started_at);
}

/** 卡片里另写的结果。和过程里最后一句回答一样时不重复。 */
export function subagentResultShown(card: SubagentEvent, steps: readonly SessionEvent[]): string {
  const result = card.result?.trim() ?? "";
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step.kind === "agent-message") return step.text.trim() === result ? "" : result;
  }
  return result;
}

/** 用量一行：`36.2K tokens · 1 次工具`。都没有时为空。 */
export function subagentUsage(card: SubagentEvent): string {
  const parts: string[] = [];
  if (card.tokens != null && card.tokens > 0) parts.push(`${formatTokens(card.tokens)} tokens`);
  if (card.tool_uses != null && card.tool_uses > 0) parts.push(`${card.tool_uses} 次工具`);
  return parts.join(" · ");
}

/** 一组里各状态的个数，运行中、失败、已停止、完成依次排。 */
export function summarizeSubagentStatuses(cards: readonly SubagentEvent[]): { status: SubagentStatus; count: number }[] {
  return STATUS_ORDER.map((status) => ({
    status,
    count: cards.filter((card) => card.status === status).length,
  })).filter((item) => item.count > 0);
}

/** 组头：`3 个子 Agent · 2 个完成 · 1 个运行中`。 */
export function subagentGroupSummary(cards: readonly SubagentEvent[]): string {
  const counts = summarizeSubagentStatuses(cards).map(
    (item) => `${item.count} 个${SUBAGENT_STATUS_LABELS[item.status]}`,
  );
  return [`${cards.length} 个子 Agent`, ...counts].join(" · ");
}
