import type { SessionEvent, SessionStatus } from "../../../types";

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

/** 进行中的折叠行：`Agent · 正在处理…`。名称由调用方传入。 */
export function runningTurnSummary(agentLabel: string): string {
  return `${agentLabel} · 正在处理…`;
}

export type TimelineNode =
  | { type: "event"; event: SessionEvent; showAgentLabel: boolean }
  | { type: "live"; id: string; events: SessionEvent[] }
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
    event.kind === "context-usage"
  );
}

/**
 * 审查重复看 `dedupe_of`。
 * 计划模式里与 plan-text 相同的正文看 `mode`，正文不同则留下。
 */
export function isSuppressedMessage(events: readonly SessionEvent[], index: number): boolean {
  const event = events[index];
  if (event.kind !== "agent-message") return false;
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
 * 正在跑的一轮收成一块，对话里用折叠行标「正在处理」；工具调用各自留在块里。
 * 停在提问时保持展开，方便回答。
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
    const last = turnIndex === turns.length - 1;
    if (status === "running" && last) {
      blocks.push({ type: "live", id: `live-${user.id}`, events: visibleEvents(rest) });
      return;
    }
    if (liveStatus && last) pushLive(blocks, rest);
    else pushSettled(blocks, rest);
  });
  if (status === "running" && !blocks.some((block) => block.type === "live")) {
    blocks.push({ type: "live", id: "live-current", events: [] });
  }
  return blocks;
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
        chars += event.summary.length + (event.detail?.length ?? 0);
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
      case "review-findings":
        chars += event.summary.length + event.findings.reduce((sum, finding) => sum + finding.body.length, 0);
        break;
      default:
        break;
    }
  }
  return chars;
}
