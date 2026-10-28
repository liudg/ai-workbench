import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import { AGENT_LABELS, type Session, type SessionEvent } from "@/types";
import { isLiveThinking } from "../events/activity-fold";
import { agentTurnName, useAgentIdentity } from "../events/use-agent-identity";
import { ActivityStream } from "./ActivityStream";
import { pickAnswer, runningTurnSummary } from "./timeline";
import { TurnFoldLine } from "./TurnFoldLine";
import { hasGeneratedImages } from "../events/generated-images";
import { EventItem } from "../events/EventItem";

/**
 * 进行中的一轮。状态行是这块的第一个子节点，已经写出来的过程接在下面。
 * 折叠行已经写了 Agent 和运行态，正文不再重复同一行名字。
 * 时间留到这一轮结束，放在所有内容（包括变更卡）之后。
 * 相邻工具收成一行。仍在思考时，活动流最后一行是「正在思考」；思考结束后这行消失。
 * 生成的图片和答复留在过程之后，收起过程仍然可见。
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
  const hasImages = events.some(hasGeneratedImages);
  const answerId = hasImages ? pickAnswer(events, false)?.id : null;
  const isAnswerContent = (event: SessionEvent) => hasGeneratedImages(event) || event.id === answerId;
  const process = events.filter((event) => !isAnswerContent(event));
  const answerContent = events.filter(isAnswerContent);

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
          events={process}
          session={session}
          resolvedAnswers={resolvedAnswers}
          showAgentLabel={() => false}
          thinking={isLiveThinking(events)}
          settled={false}
          onInteract={onInteract}
        />
      ) : null}
      {answerContent.map((event) => (
        <EventItem
          key={event.id}
          event={event}
          session={session}
          resolvedAnswer={null}
          showAgentLabel={false}
          showMessageFooter={false}
        />
      ))}
    </div>
  );
}
