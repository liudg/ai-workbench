import { useMemo } from "react";

import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import { AGENT_LABELS, type Session, type SessionEvent } from "@/types";
import { agentTurnName, useAgentIdentity } from "../events/use-agent-identity";
import { ActivityStream } from "./ActivityStream";
import { foldedEvents, runningTurnSummary } from "./timeline";
import { TurnFoldLine } from "./TurnFoldLine";

/**
 * 进行中的一轮，和结束的一轮一样按发生顺序一条流画到底，收起只隐藏过程。
 * 折叠行已经写了 Agent 和运行态，正文不再重复同一行名字。
 * 时间留到这一轮结束，放在所有内容（包括变更卡）之后。
 * 相邻工具收成一行，还在跑的工具转圈。
 * 此刻在做什么和用时的那一行由 `ChatView` 放在时间线最底下（变更卡之后）。
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
  const identity = useAgentIdentity(session.agent);
  const agentName = agentTurnName(session.agent, identity) || AGENT_LABELS[session.agent];
  const visible = useMemo(() => (expanded ? events : foldedEvents(events, false)), [events, expanded]);

  return (
    <div className="min-w-0" data-live-turn>
      <TurnFoldLine
        summary={runningTurnSummary(agentName)}
        expanded={expanded}
        onToggle={onToggle}
        icon={<SessionAgentIcon identity={identity} className="h-4 w-4" />}
        pulse
      />
      <ActivityStream
        events={visible}
        session={session}
        resolvedAnswers={resolvedAnswers}
        showAgentLabel={() => false}
        live
        settled={false}
        onInteract={onInteract}
      />
    </div>
  );
}
