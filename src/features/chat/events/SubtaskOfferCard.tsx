import { useState } from "react";
import { GitBranch, Split } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import type { SessionSpec } from "@/types";
import { useChatHost } from "../host";
import { offerLabels, offerState } from "./subtask-offer";
import { SubtaskRows } from "./SubtaskRows";
import type { EventViewProps } from "./types";
import { agentTurnName, useAgentIdentity } from "./use-agent-identity";

/**
 * Agent 开的子任务。直接开的和选了「另开」的画成子任务行；还没选的是一张卡片，等用户选另开还是不开。
 * 照 Claude Code 桌面版嵌套会话的卡片。
 */
export function SubtaskOfferCard({ event }: EventViewProps) {
  const subtasks = useChatHost().subtasks;
  const [busy, setBusy] = useState(false);
  if (event.kind !== "subtask-offer") return null;
  const state = offerState(event, Date.now());
  if (event.resolution?.kind === "accepted") {
    return <SubtaskRows taskIds={event.resolution.task_ids} specs={event.subtasks} />;
  }
  const labels = offerLabels(event.initiation, event.link);
  const choose = (accept: boolean) => {
    if (!subtasks || busy) return;
    setBusy(true);
    void subtasks.resolveOffer(event.session_id, event.offer_id, accept).finally(() => setBusy(false));
  };
  return (
    <div className="event-in min-w-0 px-6 py-2" data-subtask-offer={state}>
      <div className="min-w-0 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-400">
          <Split className="h-3.5 w-3.5 shrink-0" />
          <span>{labels.title}</span>
        </div>
        <ul className="mt-2 flex min-w-0 flex-col gap-2">
          {event.subtasks.map((spec, index) => (
            <OfferItem key={index} spec={spec} />
          ))}
        </ul>
        <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-2 text-xs text-zinc-500">
          {state === "pending" && subtasks ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => choose(true)}>
                {labels.accept}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => choose(false)}>
                {labels.decline}
              </Button>
            </>
          ) : null}
          {state === "expired" ? <span>已过期</span> : null}
          {state === "declined" ? <span>{labels.declined}</span> : null}
        </div>
      </div>
    </div>
  );
}

function OfferItem({ spec }: { spec: SessionSpec }) {
  const identity = useAgentIdentity(spec.agent);
  return (
    <li className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5 text-sm text-zinc-200">
        <SessionAgentIcon identity={identity} className="h-3.5 w-3.5" />
        <span className="min-w-0 truncate font-medium">{spec.title}</span>
        <span className="shrink-0 text-xs text-zinc-500">{agentTurnName(spec.agent, identity)}</span>
        {spec.worktree ? (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-zinc-500">
            <GitBranch className="h-3 w-3" />
            工作树
          </span>
        ) : null}
      </div>
      {spec.prompt ? (
        <p className="mt-0.5 line-clamp-2 min-w-0 break-words pl-5 text-xs leading-5 text-zinc-500">{spec.prompt}</p>
      ) : null}
    </li>
  );
}
