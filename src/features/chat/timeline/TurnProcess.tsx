import { useMemo, useState } from "react";

import { showsFileChanges } from "@/features/changes-model/capabilities";
import { turnChanges } from "@/features/changes-model/diff-parse";
import { useChangeCapabilities } from "@/features/changes-model/use-changes";
import { ChangeCard } from "../cards/ChangeCard";
import { EventItem } from "../events/EventItem";
import { collapsedTurnSummary, isProcess } from "./timeline";
import { TurnFoldLine } from "./TurnFoldLine";
import { SessionAgentIcon } from "@/features/sidebar/sessions/SessionAgentIcon";
import { AGENT_LABELS, type Session, type SessionEvent } from "@/types";
import { agentTurnName, useAgentIdentity } from "../events/use-agent-identity";

/**
 * 一轮结束后的过程条。名称和用时在同一行，工具芯片留在行下。
 * 展开后补上旁白和思考；最终答复留在下面，并只标一次 Agent。
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
  const identity = useAgentIdentity(session.agent);
  const agentName = agentTurnName(session.agent, identity) || AGENT_LABELS[session.agent];
  const changeFlags = useChangeCapabilities(session.agent);
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
        summary={collapsedTurnSummary(agentName, durationMs)}
        expanded={expanded}
        onToggle={onToggle}
        icon={<SessionAgentIcon identity={identity} className="h-4 w-4" />}
      />
      {(expanded ? process : process.filter((event) => event.kind === "tool-call")).map((event) =>
        renderEvent(event, false),
      )}
      {answer ? renderEvent(answer, false) : null}
      {chromeAfter.map((event) => renderEvent(event, false))}
      {changes ? <ChangeCard changes={changes} /> : null}
    </div>
  );
}
