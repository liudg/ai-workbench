import { useWorkbench } from "@/store";
import type { AgentKind, ChangeCapabilities } from "@/types";

/** 当前 Agent 的变更能力。界面不直接读 profile store。 */
export function useChangeCapabilities(agent: AgentKind): ChangeCapabilities | undefined {
  return useWorkbench((state) => state.profiles[agent]?.capabilities.changes);
}
