import type { AgentKind, ChangeCapabilities } from "@/types";
import { useChatHost } from "./host";

/** 当前 Agent 的变更能力。 */
export function useChangeCapabilities(agent: AgentKind): ChangeCapabilities | undefined {
  return useChatHost().profiles[agent]?.capabilities.changes;
}
