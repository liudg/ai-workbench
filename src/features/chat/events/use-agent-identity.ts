import { AGENT_LABELS, type AgentKind, type Session, type SessionEvent } from "@/types";
import { agentIdentity, type AgentIdentity } from "@/shared/agent/identity";
import { useChatHost } from "../host";

/** 这一条会话自己的适配器图标和显示名。资料对不上就不编。 */
export function useAgentIdentity(agent: AgentKind): AgentIdentity | null {
  return agentIdentity(agent, useChatHost().profiles[agent]);
}

/** 写这条事件的 Agent。中途换过 Agent 时，前面几段不是会话现在的 Agent。 */
export function useEventAgent(event: SessionEvent | undefined, session: Session): AgentKind {
  const host = useChatHost();
  return (event && host.agentOf?.(event.session_id)) || session.agent;
}

export function agentTurnName(agent: AgentKind, identity: AgentIdentity | null): string {
  const name = identity?.name.trim() ?? "";
  return name || AGENT_LABELS[agent];
}
