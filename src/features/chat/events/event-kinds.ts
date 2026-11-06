import type { SessionEvent } from "../../../types/index.ts";

/** 时间线上要画出的事件。新增 kind 时这里和 registry 必须一起补。 */
export const RENDERED_EVENT_KINDS = [
  "user-message",
  "agent-message",
  "thinking",
  "tool-call",
  "prompt",
  "system",
  "read-only",
  "error",
  "handoff",
  "plan-steps",
  "plan-text",
  "review-note",
  "review-findings",
  "subtask-offer",
  "subagent",
] as const satisfies readonly SessionEvent["kind"][];

/** 进日志但不进时间线的事件。子 Agent 的步骤画在它的卡片里。 */
export const SILENT_EVENT_KINDS = [
  "prompt-resolved",
  "status-changed",
  "turn-anchor",
  "turn-diff",
  "file-change",
  "turn-changes",
  "collaboration-mode",
  "goal",
  "context-usage",
  "session-usage",
  "subagent-step",
  "subagent-ended",
] as const satisfies readonly SessionEvent["kind"][];

export type RenderedEventKind = (typeof RENDERED_EVENT_KINDS)[number];
export type SilentEventKind = (typeof SILENT_EVENT_KINDS)[number];

type MissingKind = Exclude<SessionEvent["kind"], RenderedEventKind | SilentEventKind>;
type OverlappingKind = Extract<RenderedEventKind, SilentEventKind>;

/** 编译期保证两种列表刚好盖住全部事件，且互不重叠。 */
export const eventKindCoverage: [MissingKind, OverlappingKind] extends [never, never] ? true : never = true;

export function isRenderedEventKind(kind: SessionEvent["kind"]): kind is RenderedEventKind {
  return (RENDERED_EVENT_KINDS as readonly string[]).includes(kind);
}

export function eventKindDisposition(kind: SessionEvent["kind"]): "render" | "silent" {
  return isRenderedEventKind(kind) ? "render" : "silent";
}
