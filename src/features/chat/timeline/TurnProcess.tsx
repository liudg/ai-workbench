import { useMemo } from "react";

import { formatMessageTime } from "@/lib/utils";
import { showsFileChanges } from "@/features/changes-model/capabilities";
import { turnChanges } from "@/features/changes-model/diff-parse";
import { useChangeCapabilities } from "../use-change-capabilities";
import { ChangeCard } from "../cards/ChangeCard";
import { EventItem } from "../events/EventItem";
import { MessageFooter } from "../events/chrome";
import { collapsedTurnSummary, isProcess } from "./timeline";
import { ActivityStream } from "./ActivityStream";
import { TurnFoldLine } from "./TurnFoldLine";
import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import { AGENT_LABELS, type Session, type SessionEvent } from "@/types";
import { agentTurnName, useAgentIdentity, useEventAgent } from "../events/use-agent-identity";
import { hasGeneratedImages } from "../events/generated-images";

/**
 * 一轮结束后的过程条。状态行是这块的第一个子节点，名称和用时在同一行。
 * 收起时过程收进这一行。展开后补上旁白，工具、命令、集成和查看图像各收成一行，再点开才看到步骤。
 * 结束后的思考不留条目。最终答复留在下面，时间和复制放在所有内容（包括变更卡）之后。
 * 折叠行已经带了 Agent 名，答复不再重复。答复前的说明接在状态行下面。
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
  const answerIndex = answerId == null ? -1 : events.findIndex((event) => event.id === answerId);
  const before = answerIndex >= 0 ? events.slice(0, answerIndex) : events;
  const answer = answerIndex >= 0 ? events[answerIndex] : null;
  const after = answerIndex >= 0 ? events.slice(answerIndex + 1) : [];
  const process = events.filter((event) => isProcess(event, answerId));
  const chromeBefore = before.filter((event) => !isProcess(event, answerId) && !hasGeneratedImages(event));
  const answerImages = before.filter(hasGeneratedImages);
  const chromeAfter = after.filter((event) => !isProcess(event, answerId));
  const agent = useEventAgent(events[0], session);
  const identity = useAgentIdentity(agent);
  const agentName = agentTurnName(agent, identity) || AGENT_LABELS[agent];
  const changeFlags = useChangeCapabilities(agent);
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
      showMessageFooter={false}
    />
  );

  return (
    <div className="group min-w-0">
      <TurnFoldLine
        summary={collapsedTurnSummary(agentName, durationMs)}
        expanded={expanded}
        onToggle={onToggle}
        icon={<SessionAgentIcon identity={identity} className="h-4 w-4" />}
      />
      {chromeBefore.map((event) => renderEvent(event, false))}
      {expanded ? (
        <ActivityStream
          events={process}
          session={session}
          resolvedAnswers={resolvedAnswers}
          showAgentLabel={() => false}
          settled
          onInteract={onInteract}
        />
      ) : null}
      {answerImages.map((event) => renderEvent(event, false))}
      {answer ? renderEvent(answer, false) : null}
      {chromeAfter.map((event) => renderEvent(event, false))}
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
