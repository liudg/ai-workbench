import { ArrowRight, ArrowRightLeft } from "lucide-react";

import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import type { AgentKind } from "@/types";
import type { EventViewProps } from "./types";
import { agentTurnName, useAgentIdentity } from "./use-agent-identity";

/** 换 Agent 或分叉的分隔：从哪个 Agent 交给哪个，交了几条前文。照 t3code `V2LifecycleRow.tsx` 的 `HandoffRow`。 */
export function HandoffNote({ event }: EventViewProps) {
  if (event.kind !== "handoff") return null;
  const label = event.delivered ? "上下文交接" : "上下文交接（未发送）";
  const counts = event.delivered
    ? [`${event.selected ?? 0} 条前文`, event.omitted ? `省略 ${event.omitted} 条` : null].filter(Boolean).join("，")
    : null;
  return (
    <div className="event-in min-w-0 px-6 py-3">
      <div className="flex min-w-0 items-center gap-3 text-xs text-wb-fg-3">
        <span className="h-px flex-1 bg-wb-border" />
        <span className="flex min-w-0 flex-wrap items-center justify-center gap-1.5">
          <ArrowRightLeft className="h-3 w-3 shrink-0" />
          <span>{label}</span>
          <Endpoint agent={event.from_agent} model={event.from_model} />
          <ArrowRight className="h-3 w-3 shrink-0" />
          <Endpoint agent={event.to_agent} model={event.to_model} />
          {counts ? <span className="text-wb-fg-3">· {counts}</span> : null}
        </span>
        <span className="h-px flex-1 bg-wb-border" />
      </div>
    </div>
  );
}

function Endpoint({ agent, model }: { agent: AgentKind; model?: string }) {
  const identity = useAgentIdentity(agent);
  const name = agentTurnName(agent, identity);
  return (
    <span className="inline-flex min-w-0 items-center gap-1 font-medium text-wb-fg-2" title={model || name}>
      <SessionAgentIcon identity={identity} className="h-3.5 w-3.5" />
      <span className="truncate">{model?.trim() || name}</span>
    </span>
  );
}
