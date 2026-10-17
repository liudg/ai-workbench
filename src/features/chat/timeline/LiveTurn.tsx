import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import { AGENT_LABELS, type Session, type SessionEvent } from "@/types";
import { isLiveThinking } from "../events/activity-fold";
import { agentTurnName, useAgentIdentity } from "../events/use-agent-identity";
import { ActivityStream } from "./ActivityStream";
import { pickAnswer, runningTurnSummary } from "./timeline";
import { TurnFoldLine } from "./TurnFoldLine";

/**
 * 进行中的一轮。状态行是这块的第一个子节点，已经写出来的过程接在下面。
 * 相邻工具收成一行。仍在思考时，活动流最后一行是「正在思考」；思考结束后这行消失。
 * 收起时只留状态行。
 */
export function LiveTurn({
  events,
  session,
  resolvedAnswers,
  expanded,
  onToggle,
  onInteract,
}: {
  events: SessionEvent[];
  session: Session;
  resolvedAnswers: ReadonlyMap<string, string>;
  expanded: boolean;
  onToggle: () => void;
  onInteract?: () => void;
}) {
  const answer = pickAnswer(events, false);
  const identity = useAgentIdentity(session.agent);
  const agentName = agentTurnName(session.agent, identity) || AGENT_LABELS[session.agent];

  return (
    <div className="min-w-0" data-live-turn>
      <TurnFoldLine
        summary={runningTurnSummary(agentName)}
        expanded={expanded}
        onToggle={onToggle}
        icon={<SessionAgentIcon identity={identity} className="h-4 w-4" />}
        pulse
      />
      {expanded ? (
        <ActivityStream
          events={events}
          session={session}
          resolvedAnswers={resolvedAnswers}
          showAgentLabel={(event) => answer != null && event.id === answer.id}
          thinking={isLiveThinking(events)}
          settled={false}
          onInteract={onInteract}
        />
      ) : null}
    </div>
  );
}
