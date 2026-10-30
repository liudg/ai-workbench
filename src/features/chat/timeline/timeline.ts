import type { SessionEvent, SessionStatus } from "../../../types";
import { choiceHasSlot } from "../events/pending-plan-choice.ts";
import { hasGeneratedImages } from "../events/generated-images.ts";
import { steerFlags } from "../../../shared/session/steer.ts";

/**
 * 时间线以事件日志里最后一次状态为准。
 * 会话列表刷新可能晚一拍，对话里的「正在处理」要跟这一轮结束对齐。
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
 * 折叠后的一行：`Agent · 用时 3s`。
 * 名称由调用方按会话 Agent 传入，这里不区分种类。
 */
export function collapsedTurnSummary(agentLabel: string, durationMs: number): string {
  return `${agentLabel} · 用时 ${formatElapsed(durationMs)}`;
}

/** 进行中的折叠行：`Agent · 运行中`。名称由调用方传入。 */
export function runningTurnSummary(agentLabel: string): string {
  return `${agentLabel} · 运行中`;
}

export type TimelineNode =
  | { type: "event"; event: SessionEvent; showAgentLabel: boolean }
  | {
      type: "live";
      id: string;
      events: SessionEvent[];
      /** 这一轮从哪一刻算起。末行计时用；不知道就是 null。 */
      startedAt: number | null;
    }
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
    event.kind === "collaboration-mode" ||
    event.kind === "goal" ||
    event.kind === "context-usage" ||
    event.kind === "session-usage"
  );
}

/**
 * CLI 断线时写进助手正文的固定句子。这不是模型答复。
 * 会话 `75f542b0` 末行与 `claude.exe` 里的常量一致。
 */
export const CLI_CONNECTION_LOST_TEXT =
  "API Error: Connection lost mid-response. The response above may be incomplete.";

export function isCliConnectionLostAnswer(text: string): boolean {
  return text.trim() === CLI_CONNECTION_LOST_TEXT;
}

/**
 * 审查重复看 `dedupe_of`。
 * 计划模式里与 plan-text 相同的正文看 `mode`，正文不同则留下。
 * 接口断线的英文句子不进时间线。
 */
export function isSuppressedMessage(events: readonly SessionEvent[], index: number): boolean {
  const event = events[index];
  if (event.kind !== "agent-message") return false;
  if (isCliConnectionLostAnswer(event.text)) return true;
  if (event.dedupe_of) return true;
  if (event.mode !== "plan") return false;
  const text = event.text.trim();
  if (!text) return false;
  return planTextNearby(events, index, text);
}

function planTextNearby(events: readonly SessionEvent[], index: number, text: string): boolean {
  for (let step = -1; step <= 1; step += 2) {
    for (let cursor = index + step; cursor >= 0 && cursor < events.length; cursor += step) {
      const other = events[cursor];
      if (other.kind === "user-message") break;
      if (other.kind === "plan-text" && other.text.trim() === text) return true;
    }
  }
  return false;
}

function hiddenInTimeline(events: readonly SessionEvent[], index: number): boolean {
  return skippedInTimeline(events[index]) || isSuppressedMessage(events, index);
}

export function isProcess(event: SessionEvent, answer: string | null | ReadonlySet<string>): boolean {
  if (hasGeneratedImages(event)) return false;
  if (typeof answer === "string" ? event.id === answer : answer?.has(event.id)) return false;
  if (choiceHasSlot(event)) return false;
  return (
    event.kind === "thinking" ||
    event.kind === "tool-call" ||
    event.kind === "prompt" ||
    event.kind === "agent-message"
  );
}

/** 从这一轮开始（用户消息或 Agent 自己开的回合）到最后一条过程或答复。 */
function elapsedMs(startedAt: number, events: readonly SessionEvent[]): number {
  const timed = events.filter(
    (event) =>
      event.kind === "thinking" ||
      event.kind === "tool-call" ||
      event.kind === "prompt" ||
      event.kind === "prompt-resolved" ||
      event.kind === "agent-message",
  );
  if (timed.length === 0) return 0;
  return Math.max(0, timed[timed.length - 1].ts - startedAt);
}

function visibleEvents(events: readonly SessionEvent[]): SessionEvent[] {
  return events.filter((_, index) => !hiddenInTimeline(events, index));
}

function pushLive(blocks: TimelineNode[], events: readonly SessionEvent[]) {
  const visible = visibleEvents(events);
  const answer = pickAnswer(visible, false);
  for (const event of visible) {
    blocks.push({
      type: "event",
      event,
      showAgentLabel: answer != null && event.id === answer.id,
    });
  }
}

/** 一轮里被引导切开的一段：开头的引导（第一段没有）、这段的事件、这段留在外面的答复。 */
export interface TurnPart {
  steer: SessionEvent | null;
  events: SessionEvent[];
  answerId: string | null;
}

/**
 * 一轮按引导切成几段，每段各留自己的答复。被引导打断前已经写出来的正文是给用户看的，
 * 收起过程时不能跟着折进去。只有最后一段在进行中时才按 `settled` 挑答复。
 */
export function turnParts(events: readonly SessionEvent[], settled: boolean): TurnPart[] {
  const parts: TurnPart[] = [{ steer: null, events: [], answerId: null }];
  for (const event of events) {
    if (event.kind === "user-message") parts.push({ steer: event, events: [], answerId: null });
    else parts[parts.length - 1].events.push(event);
  }
  const kept = parts[0].events.length > 0 ? parts : parts.slice(1);
  return kept.map((part, index) => ({
    ...part,
    answerId: pickAnswer(part.events, settled || index < kept.length - 1)?.id ?? null,
  }));
}

/** 各段答复的 id。 */
export function partAnswers(parts: readonly TurnPart[]): ReadonlySet<string> {
  return new Set(parts.flatMap((part) => (part.answerId ? [part.answerId] : [])));
}

function pushSettled(blocks: TimelineNode[], startedAt: number, events: readonly SessionEvent[]) {
  const body = events.filter((_, index) => !hiddenInTimeline(events, index));
  const parts = turnParts(body, true);
  const answerId = parts[parts.length - 1]?.answerId ?? null;
  const answers = partAnswers(parts);
  const process = body.filter((event) => isProcess(event, answers));
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
  // 最后一段的答复带时间和复制。
  blocks.push({
    type: "turn",
    id: process[0].id,
    durationMs: elapsedMs(startedAt, events),
    events: body,
    answerId,
  });
}

/**
 * 把事件日志分成可渲染的块。
 * 正在跑的一轮收成一块，对话里用折叠行标「正在处理」。
 * 停在提问时保持展开，方便回答。
 * 已结束的一轮把旁白、思考和工具调用收成一块，答复单独留在下面。
 * 相邻工具再收成一行是展示层的事，这里仍按事件留下。
 * 阶段来自任意适配器写入的 `phase`，这里不看 AgentKind。
 */
/**
 * 已经写进日志的断线英文，旁边若还有笼统「报错」，改成同一句「连接中断」。
 * 只改这一轮里、断线句子之后的那条，不影响别的失败。
 */
function softenConnectionLost(events: readonly SessionEvent[]): readonly SessionEvent[] {
  const rewrite = new Set<number>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.kind !== "agent-message" || !isCliConnectionLostAnswer(event.text)) continue;
    for (let cursor = index + 1; cursor < events.length; cursor += 1) {
      const next = events[cursor];
      if (next.kind === "user-message") break;
      if (next.kind === "error" && next.message.trim() === "Claude Code 报错") rewrite.add(cursor);
    }
  }
  if (rewrite.size === 0) return events;
  return events.map((event, index) =>
    rewrite.has(index) && event.kind === "error"
      ? { ...event, message: "Claude Code 连接中断" }
      : event,
  );
}

/** 开新一段的事件：用户消息，或者换 Agent 的交接。 */
function opensSegment(event: SessionEvent): boolean {
  return event.kind === "user-message" || event.kind === "handoff";
}

/** 时间线里看得见的 Agent 活动：不是用户消息和交接，也不是只给作曲栏和状态用的事件。 */
function isActivity(events: readonly SessionEvent[], index: number): boolean {
  return !opensSegment(events[index]) && !hiddenInTimeline(events, index);
}

/**
 * 每一轮从哪条事件开始。用户消息总是开一轮。换 Agent 的交接也断开，不并进上一段的最后一轮。
 * Agent 自己开的回合（目标续跑、宿主发的命令）没有用户消息，只有 `turn-anchor`：
 * 前面这一轮已经有活动、后面在下一条用户消息之前也有活动，才算新的一轮。
 * 紧挨着用户消息的锚点属于那条消息的回合，不另开。
 * 回合进行中补进去的引导不开新的一轮，留在原来那轮里。
 */
function turnStarts(events: readonly SessionEvent[]): number[] {
  const starts: number[] = [];
  const steers = steerFlags(events);
  let activitySinceStart = false;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    // 引导的话跟着它所在的那一轮，不另起一轮。
    if (steers[index]) continue;
    if (opensSegment(event)) {
      starts.push(index);
      activitySinceStart = false;
      continue;
    }
    if (event.kind === "turn-anchor" && activitySinceStart && activityAhead(events, index)) {
      starts.push(index);
      activitySinceStart = false;
      continue;
    }
    if (isActivity(events, index)) activitySinceStart = true;
  }
  return starts;
}

function activityAhead(events: readonly SessionEvent[], from: number): boolean {
  for (let index = from + 1; index < events.length; index += 1) {
    if (opensSegment(events[index])) return false;
    if (isActivity(events, index)) return true;
  }
  return false;
}

/** 还没有任何一轮时，从最近一次进入运行的状态事件算起。 */
function runningSince(events: readonly SessionEvent[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === "status-changed") return event.status === "running" ? event.ts : null;
  }
  return null;
}

export function buildTimeline(
  events: readonly SessionEvent[],
  status: SessionStatus,
): TimelineNode[] {
  events = softenConnectionLost(events);
  const blocks: TimelineNode[] = [];
  const starts = turnStarts(events);
  const prefixEnd = starts[0] ?? events.length;
  for (let index = 0; index < prefixEnd; index += 1) {
    if (hiddenInTimeline(events, index)) continue;
    const event = events[index];
    blocks.push({
      type: "event",
      event,
      showAgentLabel: event.kind === "agent-message",
    });
  }

  const turns = starts.map((start, turnIndex) => events.slice(start, starts[turnIndex + 1] ?? events.length));
  const liveStatus = status === "running" || status === "needs-input";
  turns.forEach((turn, turnIndex) => {
    const leader = turn[0];
    // Agent 自己开的回合没有用户气泡。
    if (opensSegment(leader)) blocks.push({ type: "event", event: leader, showAgentLabel: false });
    const rest = turn.slice(1);
    const last = turnIndex === turns.length - 1;
    if (status === "running" && last) {
      blocks.push({
        type: "live",
        id: `live-${leader.id}`,
        events: visibleEvents(rest),
        startedAt: leader.ts,
      });
      return;
    }
    if (liveStatus && last) pushLive(blocks, rest);
    else pushSettled(blocks, leader.ts, rest);
  });
  if (status === "running" && !blocks.some((block) => block.type === "live")) {
    blocks.push({ type: "live", id: "live-current", events: [], startedAt: runningSince(events) });
  }
  return blocks;
}

export type TimelineChunk =
  | { type: "events"; id: string; events: SessionEvent[]; labels: ReadonlyMap<string, boolean> }
  | { type: "block"; block: TimelineNode };

/** 用户消息、交接、已结束的一轮和进行中的一轮各自断开。中间的事件交给活动流。 */
export function chunkTimeline(blocks: readonly TimelineNode[]): TimelineChunk[] {
  const chunks: TimelineChunk[] = [];
  let events: SessionEvent[] = [];
  let labels = new Map<string, boolean>();
  const flush = () => {
    if (events.length === 0) return;
    chunks.push({ type: "events", id: events[0].id, events, labels });
    events = [];
    labels = new Map();
  };
  for (const block of blocks) {
    if (block.type === "event" && !opensSegment(block.event)) {
      events.push(block.event);
      labels.set(block.event.id, block.showAgentLabel);
      continue;
    }
    flush();
    chunks.push({ type: "block", block });
  }
  flush();
  return chunks;
}

/** 同一段时间线里块的 key。事件流加上前缀，避免和回合 id 撞车。 */
export function timelineChunkKey(chunk: TimelineChunk): string {
  if (chunk.type === "events") return `events-${chunk.id}`;
  if (chunk.block.type === "event") return chunk.block.event.id;
  return chunk.block.id;
}

/** 内容变长时用来判断要不要继续贴底。状态事件不计入。 */
export function contentChars(events: readonly SessionEvent[]): number {
  let chars = 0;
  for (const event of events) {
    switch (event.kind) {
      case "user-message":
      case "agent-message":
      case "thinking":
      case "system":
      case "read-only":
        chars += event.text.length;
        break;
      case "tool-call":
        chars += event.summary.length + (event.detail?.length ?? 0) + (event.images?.length ?? 0);
        break;
      case "error":
        chars += event.message.length;
        break;
      case "prompt":
        chars += event.question.length;
        break;
      case "file-change":
        chars += event.diff.length;
        break;
      case "turn-changes":
        chars += event.files.reduce((sum, file) => sum + file.diff.length, 0);
        break;
      case "plan-steps":
        chars += (event.explanation?.length ?? 0) + event.steps.reduce((sum, step) => sum + step.step.length, 0);
        break;
      case "plan-text":
      case "review-note":
        chars += event.text.length;
        break;
      case "review-findings": {
        const findings = Array.isArray(event.findings) ? event.findings : [];
        chars +=
          (event.summary?.length ?? 0) +
          findings.reduce((sum, finding) => sum + (finding?.body?.length ?? 0), 0);
        break;
      }
      default:
        break;
    }
  }
  return chars;
}
