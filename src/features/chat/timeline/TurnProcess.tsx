import { useMemo } from "react";

import { formatMessageTime } from "@/lib/utils";
import { showsFileChanges } from "@/features/changes-model/capabilities";
import { turnChanges } from "@/features/changes-model/diff-parse";
import { useChangeCapabilities } from "../use-change-capabilities";
import { ChangeCard } from "../cards/ChangeCard";
import { MessageFooter } from "../events/chrome";
import { SubtaskRows } from "../events/SubtaskRows";
import { collapsedTurnSummary, foldedEvents } from "./timeline";
import { ActivityStream } from "./ActivityStream";
import { TurnFoldLine } from "./TurnFoldLine";
import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import { AGENT_LABELS, type Session, type SessionEvent, type SubtaskSpec } from "@/types";
import { agentTurnName, useAgentIdentity, useEventAgent } from "../events/use-agent-identity";

/**
 * 结束的一轮。状态行是这块的第一个子节点，名称和用时在同一行。
 * 下面是这一轮的事件，按发生顺序一条流画到底；收起只隐藏过程，留下的不换位置。
 * 变更卡和时间、复制是整轮的汇总，放在最后。
 */
export function TurnProcess({
  events,
  answerId,
  durationMs,
  session,
  resolvedAnswers,
  expanded,
  onToggle,
  onInteract,
}: {
  events: SessionEvent[];
  answerId: string | null;
  durationMs: number;
  session: Session;
  resolvedAnswers: ReadonlyMap<string, string>;
  expanded: boolean;
  onToggle: () => void;
  onInteract?: () => void;
}) {
  const visible = useMemo(() => (expanded ? events : foldedEvents(events, true)), [events, expanded]);
  const answer = answerId == null ? null : (events.find((event) => event.id === answerId) ?? null);
  const subtasks = useMemo(() => {
    const created = new Map<string, SubtaskSpec>();
    for (const event of events) {
      if (event.kind !== "subtask-offer" || event.resolution?.kind !== "accepted") continue;
      event.resolution.task_ids.forEach((id, index) => {
        created.set(id, event.subtasks[index]);
      });
    }
    return { taskIds: [...created.keys()], specs: [...created.values()] };
  }, [events]);
  const agent = useEventAgent(events[0], session);
  const identity = useAgentIdentity(agent);
  const agentName = agentTurnName(agent, identity) || AGENT_LABELS[agent];
  const changeFlags = useChangeCapabilities(agent);
  const changes = useMemo(
    () => (showsFileChanges(changeFlags) ? turnChanges(events) : null),
    [changeFlags, events],
  );

  return (
    <div className="group min-w-0">
      <TurnFoldLine
        summary={collapsedTurnSummary(agentName, durationMs)}
        expanded={expanded}
        onToggle={onToggle}
        icon={<SessionAgentIcon identity={identity} className="h-4 w-4" />}
      />
      <ActivityStream
        events={visible}
        session={session}
        resolvedAnswers={resolvedAnswers}
        showAgentLabel={() => false}
        settled
        onInteract={onInteract}
      />
      {answer?.kind === "agent-message" ? <SubtaskRows {...subtasks} /> : null}
      {changes ? <ChangeCard changes={changes} /> : null}
      {answer?.kind === "agent-message" && answer.text.trim() ? (
        <div className="event-in min-w-0 px-6 py-1">
          <div className="min-w-0 pl-6">
            <MessageFooter time={formatMessageTime(answer.ts)} copyText={answer.text} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
