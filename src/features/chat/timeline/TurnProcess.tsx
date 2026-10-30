import { Fragment, useMemo } from "react";

import { formatMessageTime } from "@/lib/utils";
import { showsFileChanges } from "@/features/changes-model/capabilities";
import { turnChanges } from "@/features/changes-model/diff-parse";
import { useChangeCapabilities } from "../use-change-capabilities";
import { ChangeCard } from "../cards/ChangeCard";
import { EventItem } from "../events/EventItem";
import { MessageFooter } from "../events/chrome";
import { collapsedTurnSummary, isProcess, turnParts, type TurnPart } from "./timeline";
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
  // 被引导切开的每一段各留自己的答复；引导的话是用户写的，收起时也留着。
  // 最后一段的答复以这一轮定下的为准。
  const parts = useMemo(
    () =>
      turnParts(events, true).map((part, index, all) =>
        index === all.length - 1 ? { ...part, answerId } : part,
      ),
    [answerId, events],
  );
  const answer = answerId == null ? null : (events.find((event) => event.id === answerId) ?? null);
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

  /** 一段：答复前的说明，展开时的过程，生成的图，答复，答复后的说明。 */
  const renderPart = (part: TurnPart) => {
    const index = part.answerId == null ? -1 : part.events.findIndex((event) => event.id === part.answerId);
    const before = index >= 0 ? part.events.slice(0, index) : part.events;
    const after = index >= 0 ? part.events.slice(index + 1) : [];
    const process = part.events.filter((event) => isProcess(event, part.answerId));
    return (
      <>
        {before
          .filter((event) => !isProcess(event, part.answerId) && !hasGeneratedImages(event))
          .map((event) => renderEvent(event, false))}
        {expanded && process.length > 0 ? (
          <ActivityStream
            events={process}
            session={session}
            resolvedAnswers={resolvedAnswers}
            showAgentLabel={() => false}
            settled
            onInteract={onInteract}
          />
        ) : null}
        {before.filter(hasGeneratedImages).map((event) => renderEvent(event, false))}
        {index >= 0 ? renderEvent(part.events[index], false) : null}
        {after.filter((event) => !isProcess(event, part.answerId)).map((event) => renderEvent(event, false))}
      </>
    );
  };

  return (
    <div className="group min-w-0">
      <TurnFoldLine
        summary={collapsedTurnSummary(agentName, durationMs)}
        expanded={expanded}
        onToggle={onToggle}
        icon={<SessionAgentIcon identity={identity} className="h-4 w-4" />}
      />
      {parts.map((part) => (
        <Fragment key={part.steer?.id ?? "first"}>
          {part.steer ? renderEvent(part.steer, false) : null}
          {renderPart(part)}
        </Fragment>
      ))}
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
