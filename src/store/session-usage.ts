import type { SessionEvent } from "@/types";

export interface SessionUsageView {
  total: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface Parts {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * 适配器发出的 `session-usage` 在这里累计。
 * 快照是当时的会话总数，后到的替换先到的，并丢掉快照之前的增量。
 * Claude 运行中发出的也是这种绝对快照：每个 message id 只计一次，结束时用 jsonl 覆盖同一 id。
 * 增量按 key 只留最后一次，再加到最近一次快照上。
 * 没有 usage 事件就返回 null。上下文窗口事件不参与。
 */
export function accumulateSessionUsage(events: readonly SessionEvent[]): SessionUsageView | null {
  // 中途换过 Agent 的任务由几段会话接成，seq 各段从头算：各段分开累计再相加。
  const segments = new Map<string, SessionEvent[]>();
  for (const event of events) {
    const list = segments.get(event.session_id);
    if (list) list.push(event);
    else segments.set(event.session_id, [event]);
  }
  let total: Parts | null = null;
  for (const segment of segments.values()) {
    const parts = accumulateSegment(segment);
    if (parts) total = total ? merge(total, parts) : parts;
  }
  if (!total) return null;
  if (
    total.input === undefined &&
    total.output === undefined &&
    total.cacheRead === undefined &&
    total.cacheWrite === undefined
  ) {
    return null;
  }
  const sum =
    (total.input ?? 0) + (total.output ?? 0) + (total.cacheRead ?? 0) + (total.cacheWrite ?? 0);
  const view: SessionUsageView = { total: sum };
  if (total.input !== undefined) view.input = total.input;
  if (total.output !== undefined) view.output = total.output;
  if (total.cacheRead !== undefined) view.cacheRead = total.cacheRead;
  if (total.cacheWrite !== undefined) view.cacheWrite = total.cacheWrite;
  return view;
}

function accumulateSegment(events: readonly SessionEvent[]): Parts | null {
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.seq - right.event.seq || left.index - right.index);
  let baseline: Parts | null = null;
  const deltas = new Map<string, Parts>();
  for (const { event } of ordered) {
    if (event.kind !== "session-usage") continue;
    const parts = readParts(event);
    if (!parts) continue;
    if (event.scope === "snapshot") {
      baseline = parts;
      deltas.clear();
      continue;
    }
    if (event.scope === "delta") {
      const key = event.key?.trim();
      if (!key) continue;
      deltas.set(key, parts);
    }
  }
  if (!baseline && deltas.size === 0) return null;
  let total = baseline ?? {};
  for (const parts of deltas.values()) total = merge(total, parts);
  return total;
}

function readParts(event: Extract<SessionEvent, { kind: "session-usage" }>): Parts | null {
  const input = count(event.input_tokens);
  const output = count(event.output_tokens);
  const cacheRead = count(event.cache_read_tokens);
  const cacheWrite = count(event.cache_write_tokens);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return null;
  }
  return { input, output, cacheRead, cacheWrite };
}

function count(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function merge(left: Parts, right: Parts): Parts {
  return {
    input: add(left.input, right.input),
    output: add(left.output, right.output),
    cacheRead: add(left.cacheRead, right.cacheRead),
    cacheWrite: add(left.cacheWrite, right.cacheWrite),
  };
}

function add(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}
