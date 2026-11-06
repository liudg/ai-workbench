import type { SessionEvent, SessionStatus, SubagentStatus } from "../../../types/index.ts";
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

const SESSION_STATUS: Record<SubagentStatus, SessionStatus> = {
  running: "running",
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
};

/** 子 Agent 的状态当成一条会话的状态，单独打开它时时间线按这个分回合。 */
export function subagentSessionStatus(card: SubagentEvent): SessionStatus {
  return SESSION_STATUS[card.status];
}

/**
 * 单独打开子 Agent 时的时间线：派给它的说明当作第一条消息，接着是它自己的步骤；
 * 卡片上另写的结果和最后一句回答不同时补在最后；结束了就收尾。照 t3code 把子 Agent 投影成子线程
 * （`packages/provider-core/src/server/subagentProjection.ts`）。
 */
export function subagentTimeline(card: SubagentEvent, steps: readonly SessionEvent[]): SessionEvent[] {
  const base = { session_id: card.session_id, seq: card.seq };
  const start = card.started_at ?? card.ts;
  const events: SessionEvent[] = [];
  const prompt = card.prompt?.trim() ?? "";
  if (prompt) {
    events.push({ ...base, id: `${card.subagent_id}:prompt`, ts: start, kind: "user-message", text: prompt });
  }
  events.push({ ...base, id: `${card.subagent_id}:turn`, ts: start, kind: "turn-anchor", turn_id: card.subagent_id });
  events.push(...steps);
  const result = subagentResultShown(card, steps);
  const end = card.ended_at ?? card.ts;
  if (result) {
    events.push({ ...base, id: `${card.subagent_id}:result`, ts: end, kind: "agent-message", text: result });
  }
  if (card.status !== "running") {
    events.push({ ...base, id: `${card.subagent_id}:end`, ts: end, kind: "status-changed", status: subagentSessionStatus(card) });
  }
  return events;
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

/**
 * 组头，写明是哪个 Agent 的子 Agent：一个时 `Codex 子 Agent · 运行中`，
 * 几个时 `3 个 Codex 子 Agent · 1 个运行中 · 2 个完成`。
 */
export function subagentGroupSummary(cards: readonly SubagentEvent[], agentName: string): string {
  const who = `${agentName} 子 Agent`;
  if (cards.length === 1) return `${who} · ${SUBAGENT_STATUS_LABELS[cards[0].status]}`;
  const counts = summarizeSubagentStatuses(cards).map(
    (item) => `${item.count} 个${SUBAGENT_STATUS_LABELS[item.status]}`,
  );
  return [`${cards.length} 个 ${who}`, ...counts].join(" · ");
}

/** 行里第二行：在跑时是它正在做什么，结束了是结果的第一句。都没有时为空。 */
export function subagentDetail(card: SubagentEvent): string {
  const text = card.status === "running" ? card.activity : card.result;
  return text?.replace(/\s+/g, " ").trim() ?? "";
}
