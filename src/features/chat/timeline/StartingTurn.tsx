import { AGENT_LABELS, type Session } from "@/types";
import { agentTurnName, useAgentIdentity } from "../events/use-agent-identity";
import { UserBubble } from "../events/UserBubble";
import { LiveStatus } from "./LiveStatus";

export interface StartingMessage {
  text: string;
  images: string[];
  startedAt: number;
}

/** 新会话的第一条消息已经交出去、Agent 还在启动：先摆出这条消息和启动进度。 */
export function StartingTurn({ message, session }: { message: StartingMessage; session: Session }) {
  const identity = useAgentIdentity(session.agent);
  const agentName = agentTurnName(session.agent, identity) || AGENT_LABELS[session.agent];
  return (
    <div data-session-starting>
      <UserBubble
        event={{
          id: "starting",
          session_id: session.id,
          seq: 0,
          ts: message.startedAt,
          kind: "user-message",
          text: message.text,
          images: message.images,
        }}
        session={session}
        resolvedAnswer={null}
        time=""
        thinkingOpen={false}
        onToggleThinking={() => {}}
        showAgentLabel={false}
      />
      <LiveStatus label={`正在启动 ${agentName}`} startedAt={message.startedAt} />
    </div>
  );
}
