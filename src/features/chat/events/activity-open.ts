import type { SessionEvent } from "../../../types/index.ts";
import { isRenderedEventKind } from "./event-kinds.ts";
import { isPinnedChoice } from "./pending-plan-choice.ts";
import { isPlaceholderThinking } from "./thinking-summary.ts";
import { visibleErrorText } from "./visible-error.ts";

/**
 * 工具行与思考条目的展开状态。
 * 回合进行中可以点开（或收起自动展开的最新思考）。
 * 回合一旦结束，进行中留下的展开状态全部清空，之后只保留结束后的点击。
 */

export function toolGroupOpen(openIds: ReadonlySet<string>, id: string): boolean {
  return openIds.has(id);
}

export function toggleToolGroup(openIds: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(openIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** 从进行中变成已结束时丢掉展开。已经结束之后再调用则保持现状。 */
export function activityOpenAfterSettle(
  openIds: ReadonlySet<string>,
  wasSettled: boolean,
  settled: boolean,
): ReadonlySet<string> {
  if (settled && !wasSettled) return new Set();
  return openIds;
}

function hiddenRenderedEvent(event: SessionEvent): boolean {
  if (event.kind === "thinking" || event.kind === "agent-message") return !event.text.trim();
  if (event.kind === "prompt") return event.prompt_kind === "approval" || isPinnedChoice(event);
  if (event.kind === "error") return !visibleErrorText(event.message);
  return false;
}

/**
 * 进行中的一轮里，最后一条在时间线上真正占位的事件如果是带推理正文的思考，默认展开；
 * 仅含占位词（「思考中…」）时不展开正文，等真实推理到达后再展开；
 * 一旦后面出现工具、旁白、可见提问或本轮结束，立刻自动收起。
 */
export function activeThinkingId(
  events: readonly SessionEvent[],
  live: boolean,
  settled: boolean,
): string | null {
  if (!live || settled) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRenderedEventKind(event.kind) || hiddenRenderedEvent(event)) continue;
    if (event.kind !== "thinking") return null;
    return isPlaceholderThinking(event.text) ? null : event.id;
  }
  return null;
}

export function thinkingBlockOpen(
  overrides: ReadonlyMap<string, boolean>,
  id: string,
  activeId: string | null,
): boolean {
  return overrides.get(id) ?? id === activeId;
}

export function toggleThinkingBlock(
  overrides: ReadonlyMap<string, boolean>,
  id: string,
  activeId: string | null,
): Map<string, boolean> {
  const next = new Map(overrides);
  next.set(id, !thinkingBlockOpen(overrides, id, activeId));
  return next;
}

export function thinkingOverridesAfterSettle(
  overrides: ReadonlyMap<string, boolean>,
  wasSettled: boolean,
  settled: boolean,
): ReadonlyMap<string, boolean> {
  if (settled && !wasSettled) return new Map();
  return overrides;
}
