import type { SessionEvent, SessionStatus } from "../../../types";
import { isReviewDuplicate } from "./codex-turn.ts";

/**
 * 时间线以事件日志里最后一次状态为准。
 * 会话列表刷新可能晚一拍，折叠和「正在处理」要跟这一轮结束对齐。
 */
export function timelineStatus(
  events: readonly SessionEvent[],
  fallback: SessionStatus,
): SessionStatus {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === "status-changed") return event.status;
  }
  return fallback;
}

/**
 * 思考和工具详情在本轮还在回答、或停在提问时展开。
 * 整轮结束（完成 / 失败 / 停止）后默认折叠。
 * 不按「这一组工具刚结束」折叠，否则回答还在继续时详情会提前收起。
 */
export function turnDetailsOpen(
  events: readonly SessionEvent[],
  status: SessionStatus,
  eventIndex: number,
): boolean {
  if (status !== "running" && status !== "needs-input") return false;
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "user-message") {
      start = i;
      break;
    }
  }
  return eventIndex >= start;
}

/** `用时 1m 28s` 里的时长。零段省略，至少留下秒。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

/**
 * 折叠后的一行：`Codex CLI · 用时 3s`。
 * 名称由调用方按会话 Agent 传入，这里不区分种类。
 */
export function collapsedTurnSummary(agentLabel: string, durationMs: number): string {
  return `${agentLabel} · 用时 ${formatElapsed(durationMs)}`;
}

export type TimelineNode =
  | { type: "event"; event: SessionEvent; showAgentLabel: boolean }
  | { type: "work"; id: string; events: SessionEvent[] }
  | {
      type: "turn";
      id: string;
      durationMs: number;
      events: SessionEvent[];
      answerId: string | null;
    };

function isAgentMessage(
  event: SessionEvent,
): event is Extract<SessionEvent, { kind: "agent-message" }> {
  return event.kind === "agent-message";
}

/**
 * 这一轮要留在折叠线下面的答复。
 * 优先最后一条 final-answer；否则最后一条阶段未知或部分答复。
 * 只有旁白时，整轮结束后才把最后一条旁白当作答复，避免正文被折没。
 */
export function pickAnswer(
  events: readonly SessionEvent[],
  settled: boolean,
): SessionEvent | null {
  const messages = events.filter(isAgentMessage);
  if (messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].phase === "final-answer") return messages[i];
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const phase = messages[i].phase;
    if (phase == null || phase === "partial-answer") return messages[i];
  }
  return settled ? messages[messages.length - 1] : null;
}

function skippedInTimeline(event: SessionEvent): boolean {
  return (
    event.kind === "status-changed" ||
    event.kind === "prompt-resolved" ||
    event.kind === "turn-anchor" ||
    event.kind === "collaboration-mode"
  );
}

function hiddenInTimeline(events: readonly SessionEvent[], index: number): boolean {
  return skippedInTimeline(events[index]) || isReviewDuplicate(events, index);
}

export function isProcess(event: SessionEvent, answerId: string | null): boolean {
  if (answerId != null && event.id === answerId) return false;
  return (
    event.kind === "thinking" ||
    event.kind === "tool-call" ||
    event.kind === "prompt" ||
    event.kind === "agent-message"
  );
}

function elapsedMs(events: readonly SessionEvent[]): number {
  const timed = events.filter(
    (event) =>
      event.kind === "thinking" ||
      event.kind === "tool-call" ||
      event.kind === "prompt" ||
      event.kind === "prompt-resolved" ||
      event.kind === "agent-message",
  );
  if (timed.length < 2) return 0;
  return Math.max(0, timed[timed.length - 1].ts - timed[0].ts);
}

function pushLive(blocks: TimelineNode[], events: readonly SessionEvent[]) {
  const visible = events.filter((_, index) => !hiddenInTimeline(events, index));
  const answer = pickAnswer(visible, false);
  for (const event of visible) {
    if (event.kind === "tool-call") {
      const last = blocks[blocks.length - 1];
      if (last && last.type === "work") {
        last.events.push(event);
      } else {
        blocks.push({ type: "work", id: event.id, events: [event] });
      }
      continue;
    }
    blocks.push({
      type: "event",
      event,
      showAgentLabel: answer != null && event.id === answer.id,
    });
  }
}

function pushSettled(blocks: TimelineNode[], events: readonly SessionEvent[]) {
  const body = events.filter((_, index) => !hiddenInTimeline(events, index));
  const answer = pickAnswer(body, true);
  const answerId = answer?.id ?? null;
  const process = body.filter((event) => isProcess(event, answerId));
  if (process.length === 0) {
    for (const event of body) {
      blocks.push({
        type: "event",
        event,
        showAgentLabel: answerId != null && event.id === answerId,
      });
    }
    return;
  }
  blocks.push({
    type: "turn",
    id: process[0].id,
    durationMs: elapsedMs(events),
    events: body,
    answerId,
  });
}

/**
 * 把事件日志分成可渲染的块。
 * 进行中的一轮保持展开（工具组、思考、旁白都在外面）。
 * 已结束的一轮把旁白、思考和工具调用收成一块，答复单独留在下面。
 * 阶段来自任意适配器写入的 `phase`，这里不看 AgentKind。
 */
export function buildTimeline(
  events: readonly SessionEvent[],
  status: SessionStatus,
): TimelineNode[] {
  const blocks: TimelineNode[] = [];
  let index = 0;
  while (index < events.length && events[index].kind !== "user-message") {
    const event = events[index];
    const at = index;
    index += 1;
    if (hiddenInTimeline(events, at)) continue;
    blocks.push({
      type: "event",
      event,
      showAgentLabel: event.kind === "agent-message",
    });
  }

  const turns: SessionEvent[][] = [];
  while (index < events.length) {
    const turn: SessionEvent[] = [];
    turn.push(events[index]);
    index += 1;
    while (index < events.length && events[index].kind !== "user-message") {
      turn.push(events[index]);
      index += 1;
    }
    turns.push(turn);
  }

  const liveStatus = status === "running" || status === "needs-input";
  turns.forEach((turn, turnIndex) => {
    const user = turn[0];
    blocks.push({ type: "event", event: user, showAgentLabel: false });
    const rest = turn.slice(1);
    const live = liveStatus && turnIndex === turns.length - 1;
    if (live) pushLive(blocks, rest);
    else pushSettled(blocks, rest);
  });
  return blocks;
}
