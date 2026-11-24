import { profileForSessionAgent } from "@/shared/agent/identity";
import type { AgentKind, ChangeCapabilities } from "@/types";
import { useChatHost } from "./host";

/** 当前 Agent / 实例的变更能力。 */
export function useChangeCapabilities(
  agent: AgentKind,
  instanceId?: string | null,
): ChangeCapabilities | undefined {
  return profileForSessionAgent(agent, useChatHost().profiles, instanceId)?.capabilities.changes;
}
