import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import { AssistantAnswer } from "../answer/AssistantAnswer";
import { CopyButton, HoverActions, Row } from "./chrome";
import type { EventViewProps } from "./types";
import { agentTurnName, useAgentIdentity } from "./use-agent-identity";

export function AgentMessage({
  event,
  session,
  time,
  showAgentLabel,
  showMessageFooter,
}: EventViewProps) {
  const identity = useAgentIdentity(session.agent);
  if (event.kind !== "agent-message") return null;
  if (!event.text.trim()) return null;
  const footer = showMessageFooter ?? showAgentLabel;
  if (!showAgentLabel) {
    return (
      <div className="event-in group min-w-0 px-6 py-1">
        <div className="min-w-0 pl-6">
          <AssistantAnswer text={event.text} />
          {footer ? (
            <div data-message-footer>
              <HoverActions time={time}>{event.text ? <CopyButton text={event.text} /> : null}</HoverActions>
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <Row
      icon={<SessionAgentIcon identity={identity} className="h-4 w-4" />}
      title={agentTurnName(session.agent, identity)}
      time={time}
      copyText={event.text}
      chrome={footer ? "below" : "hidden"}
    >
      <AssistantAnswer text={event.text} />
    </Row>
  );
}
