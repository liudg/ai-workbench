import { useState } from "react";
import { Bot, ChevronRight } from "lucide-react";

import { collapsedTurnSummary, formatElapsed, isProcess } from "./timeline";
import { cn } from "@/lib/utils";
import { AGENT_LABELS, type Session, type SessionEvent } from "@/types";
import { EventItem } from "./EventItem";

/**
 * 一轮结束后的过程条。折叠时名称和用时在同一行，右侧是箭头。
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
      <FoldLine
        agentLabel={expanded ? null : AGENT_LABELS[session.agent]}
        durationMs={durationMs}
        expanded={expanded}
        onToggle={onToggle}
      />
      {expanded ? process.map((event) => renderEvent(event, false)) : null}
      {answer ? renderEvent(answer, expanded) : null}
      {chromeAfter.map((event) => renderEvent(event, false))}
    </div>
  );
}

function FoldLine({
  agentLabel,
  durationMs,
  expanded,
  onToggle,
}: {
  /** 折叠时把 Agent 名称接到用时前面；展开后名称回到最终答复上。 */
  agentLabel: string | null;
  durationMs: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const elapsed = `用时 ${formatElapsed(durationMs)}`;
  const summary = agentLabel ? collapsedTurnSummary(agentLabel, durationMs) : elapsed;
  return (
    <div className="event-in min-w-0 px-6 py-1">
      <div className="mx-auto min-w-0 max-w-3xl">
        <button
          type="button"
          data-turn-fold
          data-turn-summary={summary}
          data-expanded={expanded ? "true" : "false"}
          aria-expanded={expanded}
          title={summary}
          onClick={onToggle}
          className="group flex w-full min-w-0 flex-nowrap items-center gap-2 rounded py-0.5 text-left"
        >
          {agentLabel ? <Bot className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : null}
          <span className="min-w-0 truncate text-xs text-zinc-500 group-hover:text-zinc-400">
            {summary}
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
