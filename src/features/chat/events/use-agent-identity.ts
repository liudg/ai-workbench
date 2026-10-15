import { useWorkbench } from "@/store";
import { AGENT_LABELS, type AgentKind } from "@/types";
import { agentIdentity, type AgentIdentity } from "@/features/sidebar/sessions/agent-identity";

/** 这一条会话自己的适配器图标和显示名。资料对不上就不编。 */
export function useAgentIdentity(agent: AgentKind): AgentIdentity | null {
  const profile = useWorkbench((state) => state.profiles[agent]);
  return agentIdentity(agent, profile);
}

export function agentTurnName(agent: AgentKind, identity: AgentIdentity | null): string {
  const name = identity?.name.trim() ?? "";
  return name || AGENT_LABELS[agent];
}
