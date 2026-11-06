import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import { AssistantAnswer } from "../answer/AssistantAnswer";
import { useMessageMenu } from "../message-menu";
import { MessageFooter, Row } from "./chrome";
import type { EventViewProps } from "./types";
import { agentTurnName, useAgentIdentity, useEventAgent } from "./use-agent-identity";

export function AgentMessage({
  event,
  session,
  time,
  showAgentLabel,
  showMessageFooter,
}: EventViewProps) {
  const agent = useEventAgent(event, session);
  const identity = useAgentIdentity(agent);
  const onContextMenu = useMessageMenu(event.kind === "agent-message" ? event.text : "");
  if (event.kind !== "agent-message") return null;
  if (!event.text.trim()) return null;
  const footer = showMessageFooter ?? showAgentLabel;
  if (!showAgentLabel) {
    return (
      <div className="event-in group min-w-0 px-6 py-1">
        <div className="min-w-0 pl-6">
          <div data-message-body onContextMenu={onContextMenu}>
            <AssistantAnswer text={event.text} />
          </div>
          {footer ? (
            <MessageFooter time={time} copyText={event.text} />
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <Row
      icon={<SessionAgentIcon identity={identity} className="h-4 w-4" />}
      title={agentTurnName(agent, identity)}
      time={time}
      copyText={event.text}
      chrome={footer ? "below" : "hidden"}
    >
      <div data-message-body onContextMenu={onContextMenu}>
        <AssistantAnswer text={event.text} />
      </div>
    </Row>
  );
}
