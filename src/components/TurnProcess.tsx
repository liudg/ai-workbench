import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { formatElapsed } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import type { Session, SessionEvent } from "@/types";
import { EventItem } from "./EventItem";

function isProcess(event: SessionEvent, answerId: string | null): boolean {
  if (answerId != null && event.id === answerId) return false;
  return (
    event.kind === "thinking" ||
    event.kind === "tool-call" ||
    event.kind === "prompt" ||
    event.kind === "agent-message"
  );
}

/**
 * 一轮结束后的过程条：只显示用时和右侧箭头。
 * 展开后是旁白、思考和工具调用；最终答复留在下面，并只标一次 Agent。
 */
export function TurnProcess({
  events,
  answerId,
  durationMs,
  session,
  resolvedAnswers,
  expanded,
  onToggle,
}: {
  events: SessionEvent[];
  answerId: string | null;
  durationMs: number;
  session: Session;
  resolvedAnswers: ReadonlyMap<string, string>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [thinkingClosed, setThinkingClosed] = useState<ReadonlySet<string>>(new Set());
  const answerIndex = answerId == null ? -1 : events.findIndex((event) => event.id === answerId);
  const before = answerIndex >= 0 ? events.slice(0, answerIndex) : events;
  const answer = answerIndex >= 0 ? events[answerIndex] : null;
  const after = answerIndex >= 0 ? events.slice(answerIndex + 1) : [];
  const process = events.filter((event) => isProcess(event, answerId));
  const chromeBefore = before.filter((event) => !isProcess(event, answerId));
  const chromeAfter = after.filter((event) => !isProcess(event, answerId));

  const renderEvent = (event: SessionEvent, showAgentLabel: boolean) => (
    <EventItem
      key={event.id}
      event={event}
      session={session}
      resolvedAnswer={
        event.kind === "prompt" ? (resolvedAnswers.get(event.prompt_id) ?? null) : null
      }
      showAgentLabel={showAgentLabel}
      thinkingOpen={event.kind === "thinking" ? !thinkingClosed.has(event.id) : undefined}
      onToggleThinking={
        event.kind === "thinking"
          ? () => {
              setThinkingClosed((prev) => {
                const next = new Set(prev);
                if (next.has(event.id)) next.delete(event.id);
                else next.add(event.id);
                return next;
              });
            }
          : undefined
      }
    />
  );

  return (
    <div className="min-w-0">
      {chromeBefore.map((event) => renderEvent(event, false))}
      <FoldLine durationMs={durationMs} expanded={expanded} onToggle={onToggle} />
      {expanded ? process.map((event) => renderEvent(event, false)) : null}
      {answer ? renderEvent(answer, true) : null}
      {chromeAfter.map((event) => renderEvent(event, false))}
    </div>
  );
}

function FoldLine({
  durationMs,
  expanded,
  onToggle,
}: {
  durationMs: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const label = `用时 ${formatElapsed(durationMs)}`;
  return (
    <div className="event-in min-w-0 px-6 py-1">
      <div className="mx-auto min-w-0 max-w-3xl">
        <button
          type="button"
          data-turn-fold
          data-expanded={expanded ? "true" : "false"}
          aria-expanded={expanded}
          onClick={onToggle}
          className="group flex w-full min-w-0 items-center gap-2 rounded py-0.5 text-left"
        >
          <span className="min-w-0 break-words text-xs text-zinc-500 group-hover:text-zinc-400">
            {label}
          </span>
          <ChevronRight
            className={cn(
              "ml-auto h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform duration-150",
              expanded && "rotate-90",
            )}
          />
        </button>
      </div>
    </div>
  );
}
