import { AGENT_LABELS, type AgentKind } from "@/types";
import { agentIdentity, type AgentIdentity } from "@/shared/agent/identity";
import { useChatHost } from "../host";

/** 这一条会话自己的适配器图标和显示名。资料对不上就不编。 */
export function useAgentIdentity(agent: AgentKind): AgentIdentity | null {
  return agentIdentity(agent, useChatHost().profiles[agent]);
}

export function agentTurnName(agent: AgentKind, identity: AgentIdentity | null): string {
  const name = identity?.name.trim() ?? "";
  return name || AGENT_LABELS[agent];
}
