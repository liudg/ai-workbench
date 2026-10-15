import { SessionAgentIcon } from "@/features/sidebar/sessions/SessionAgentIcon";
import { AssistantAnswer } from "../answer/AssistantAnswer";
import { Row } from "./chrome";
import type { EventViewProps } from "./types";
import { agentTurnName, useAgentIdentity } from "./use-agent-identity";

export function AgentMessage({ event, session, time, showAgentLabel }: EventViewProps) {
  const identity = useAgentIdentity(session.agent);
  if (event.kind !== "agent-message") return null;
  if (!showAgentLabel) {
    return (
      <div className="event-in min-w-0 px-6 py-1">
        <div className="min-w-0 pl-6">
          <AssistantAnswer text={event.text} />
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
      actionsBelow
    >
      <AssistantAnswer text={event.text} />
    </Row>
  );
}
