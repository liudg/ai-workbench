import { Bot } from "lucide-react";

import { AGENT_LABELS } from "@/types";
import { AssistantAnswer } from "../answer/AssistantAnswer";
import { Row } from "./chrome";
import type { EventViewProps } from "./types";

export function AgentMessage({ event, session, time, showAgentLabel }: EventViewProps) {
  if (event.kind !== "agent-message") return null;
  if (!showAgentLabel) {
    return (
      <div className="event-in min-w-0 px-6 py-1">
        <div className="mx-auto min-w-0 max-w-3xl pl-6">
          <AssistantAnswer text={event.text} />
        </div>
      </div>
    );
  }
  return (
    <Row
      icon={<Bot className="h-3.5 w-3.5" />}
      title={AGENT_LABELS[session.agent]}
      time={time}
      copyText={event.text}
      actionsBelow
    >
      <AssistantAnswer text={event.text} />
    </Row>
  );
}
