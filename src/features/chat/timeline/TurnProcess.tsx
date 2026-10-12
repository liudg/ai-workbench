import { useMemo, useState } from "react";

import { showsFileChanges } from "@/features/changes-model/capabilities";
import { turnChanges } from "@/features/changes-model/diff-parse";
import { useWorkbench } from "@/store";
import { ChangeCard } from "../cards/ChangeCard";
import { EventItem } from "../events/EventItem";
import { collapsedTurnSummary, formatElapsed, isProcess } from "./timeline";
import { TurnFoldLine } from "./TurnFoldLine";
import { AGENT_LABELS, type Session, type SessionEvent } from "@/types";

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
  const [thinkingOpenIds, setThinkingOpenIds] = useState<ReadonlySet<string>>(new Set());
  const answerIndex = answerId == null ? -1 : events.findIndex((event) => event.id === answerId);
  const before = answerIndex >= 0 ? events.slice(0, answerIndex) : events;
  const answer = answerIndex >= 0 ? events[answerIndex] : null;
  const after = answerIndex >= 0 ? events.slice(answerIndex + 1) : [];
  const process = events.filter((event) => isProcess(event, answerId));
  const chromeBefore = before.filter((event) => !isProcess(event, answerId));
  const chromeAfter = after.filter((event) => !isProcess(event, answerId));
  const changeFlags = useWorkbench((state) => state.profiles[session.agent]?.capabilities.changes);
  const changes = useMemo(
    () => (showsFileChanges(changeFlags) ? turnChanges(events) : null),
    [changeFlags, events],
  );

  const renderEvent = (event: SessionEvent, showAgentLabel: boolean) => (
    <EventItem
      key={event.id}
      event={event}
      session={session}
      resolvedAnswer={
        event.kind === "prompt" ? (resolvedAnswers.get(event.prompt_id) ?? null) : null
      }
      showAgentLabel={showAgentLabel}
      thinkingOpen={event.kind === "thinking" ? thinkingOpenIds.has(event.id) : undefined}
      onToggleThinking={
        event.kind === "thinking"
          ? () => {
              setThinkingOpenIds((prev) => {
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
      <TurnFoldLine
        summary={
          expanded
            ? `用时 ${formatElapsed(durationMs)}`
            : collapsedTurnSummary(AGENT_LABELS[session.agent], durationMs)
        }
        expanded={expanded}
        onToggle={onToggle}
        showAgentIcon={!expanded}
      />
      {expanded ? process.map((event) => renderEvent(event, false)) : null}
      {answer ? renderEvent(answer, expanded) : null}
      {chromeAfter.map((event) => renderEvent(event, false))}
      {changes ? <ChangeCard changes={changes} /> : null}
    </div>
  );
}
