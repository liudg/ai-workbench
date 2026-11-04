import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { SessionEvent } from "@/types";
import { subagentSteps } from "./subagent-display";

const EMPTY: SessionEvent[] = [];
const SubagentStepsContext = createContext<ReadonlyMap<string, SessionEvent[]>>(new Map());

/** 把这个会话里各子 Agent 的步骤交给卡片。时间线不画这些步骤。 */
export function SubagentStepsProvider({ events, children }: { events: readonly SessionEvent[]; children: ReactNode }) {
  const steps = useMemo(() => subagentSteps(events), [events]);
  return <SubagentStepsContext.Provider value={steps}>{children}</SubagentStepsContext.Provider>;
}

/** 一个子 Agent 自己的回答、思考和工具。 */
export function useSubagentSteps(subagentId: string): SessionEvent[] {
  return useContext(SubagentStepsContext).get(subagentId) ?? EMPTY;
}
