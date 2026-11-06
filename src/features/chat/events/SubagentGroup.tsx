import { Ban, Check, ChevronRight, Loader2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Session, SubagentStatus } from "@/types";
import { useChatHost } from "../host";
import { formatElapsed } from "../timeline/timeline";
import { useElapsedSince } from "../timeline/useElapsedSince";
import { AgentAvatar } from "./AgentAvatar";
import { HoverCard } from "./HoverCard";
import {
  SUBAGENT_STATUS_LABELS,
  subagentDetail,
  subagentElapsed,
  subagentGroupSummary,
  subagentMeta,
  subagentTitle,
  subagentUsage,
  type SubagentEvent,
} from "./subagent-display";
import type { EventViewProps } from "./types";
import { agentTurnName, useAgentIdentity, useEventAgent } from "./use-agent-identity";

const STATUS_DOT: Record<SubagentStatus, string> = {
  running: "bg-[#8fb4ff]",
  completed: "bg-emerald-400",
  failed: "bg-red-400",
  stopped: "bg-[#6a6a6a]",
};

/**
 * Agent 自带的子 Agent。一个也画组头，写明是哪个 Agent 的子 Agent；每行点开是它自己的视图，悬停看说明和结果。
 * 照 t3code `apps/web/src/components/chat/TimelineV2EventRow.tsx` 的 `V2SubagentGroup` 和
 * `V2LifecycleRow.tsx` 的 `SubagentTimelineLink`。
 */
export function SubagentGroup({ cards, session }: { cards: SubagentEvent[]; session: Session }) {
  const agent = useEventAgent(cards[0], session);
  const identity = useAgentIdentity(agent);
  const running = cards.some((card) => card.status === "running");
  return (
    <div className="event-in min-w-0 px-6 py-1" data-subagent-group={cards.length}>
      <div className="min-w-0 pl-6">
        <div className="overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#1a1a1a]">
          <div
            data-subagent-summary
            className="flex min-w-0 items-center gap-2.5 border-b border-[#2a2a2a] px-3 py-2 text-[13px] text-[#9a9a9a]"
          >
            <AgentAvatar identity={identity} className="h-5 w-5" />
            <span className="min-w-0 flex-1 truncate">{subagentGroupSummary(cards, agentTurnName(agent, identity))}</span>
            {running ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#8fb4ff] motion-reduce:animate-none" />
            ) : null}
          </div>
          <ul className="m-0 list-none p-0">
            {cards.map((card, index) => (
              <SubagentRow key={card.subagent_id} card={card} divided={index > 0} identityAgent={agent} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** 单独一张卡片直接进时间线时用。 */
export function SubagentCardEvent({ event, session }: EventViewProps) {
  if (event.kind !== "subagent") return null;
  return <SubagentGroup cards={[event]} session={session} />;
}

function SubagentRow({
  card,
  divided,
  identityAgent,
}: {
  card: SubagentEvent;
  divided: boolean;
  identityAgent: Session["agent"];
}) {
  const openSubagent = useChatHost().openSubagent;
  const identity = useAgentIdentity(identityAgent);
  const running = card.status === "running";
  const ticking = useElapsedSince(running ? (card.started_at ?? null) : null);
  const elapsed = running && ticking != null ? ticking : subagentElapsed(card, Date.now());
  const title = subagentTitle(card);
  const meta = subagentMeta(card);
  const detail = subagentDetail(card);
  const content = (
    <>
      <AgentAvatar identity={identity} dotClass={STATUS_DOT[card.status]} pulse={running} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-[13px] text-[#d4d4d4]">{title}</span>
          {meta ? <span className="min-w-0 shrink truncate text-[12px] text-[#7a7a7a]">{meta}</span> : null}
        </span>
        {detail ? (
          <span
            className={cn("block truncate text-[12px] leading-5", card.status === "failed" ? "text-red-400/90" : "text-[#8a8a8a]")}
            data-subagent-activity
          >
            {detail}
          </span>
        ) : null}
      </span>
      {card.background && running ? <span className="shrink-0 text-[12px] text-[#7a7a7a]">后台</span> : null}
      <span className="flex shrink-0 items-center gap-1 text-[12px] text-[#8a8a8a]">
        <StatusMark status={card.status} />
        <span className={cn("tabular-nums", card.status === "failed" && "text-red-400/90")}>
          {elapsed != null && card.status !== "failed"
            ? running
              ? formatElapsed(elapsed)
              : `${SUBAGENT_STATUS_LABELS[card.status]} · ${formatElapsed(elapsed)}`
            : SUBAGENT_STATUS_LABELS[card.status]}
        </span>
      </span>
      {openSubagent ? <ChevronRight className="h-4 w-4 shrink-0 text-[#777]" /> : null}
    </>
  );
  const rowClass = "flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left";
  return (
    <li
      className={cn(divided && "border-t border-[#2a2a2a]")}
      data-subagent={card.subagent_id}
      data-subagent-status={card.status}
    >
      <HoverCard content={<SubagentCardDetails card={card} />}>
        {openSubagent ? (
          <button
            type="button"
            data-subagent-open
            aria-label={`打开 ${title}`}
            onClick={() => openSubagent(card.session_id, card.subagent_id)}
            className={cn(rowClass, "hover:bg-[#222]")}
          >
            {content}
          </button>
        ) : (
          <div className={rowClass}>{content}</div>
        )}
      </HoverCard>
    </li>
  );
}

/** 悬停卡片：说明、正在做的、结果和用量。 */
function SubagentCardDetails({ card }: { card: SubagentEvent }) {
  const prompt = card.prompt?.trim() ?? "";
  const activity = card.status === "running" ? (card.activity?.trim() ?? "") : "";
  const result = card.result?.trim() ?? "";
  const usage = subagentUsage(card);
  const meta = [subagentMeta(card), SUBAGENT_STATUS_LABELS[card.status]].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-col gap-1.5">
      <div className="font-medium text-[#e4e4e4]">{subagentTitle(card)}</div>
      <div className="text-[#8a8a8a]">{meta}</div>
      {prompt ? <p className="m-0 line-clamp-4 whitespace-pre-wrap break-words text-[#9a9a9a]">{prompt}</p> : null}
      {activity ? <p className="m-0 truncate text-[#bdbdbd]">{activity}</p> : null}
      {result ? <p className="m-0 line-clamp-4 whitespace-pre-wrap break-words text-[#bdbdbd]">{result}</p> : null}
      {usage ? <div className="text-[#7a7a7a]">{usage}</div> : null}
    </div>
  );
}

function StatusMark({ status }: { status: SubagentStatus }) {
  switch (status) {
    case "running":
      return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#8fb4ff] motion-reduce:animate-none" />;
    case "completed":
      return <Check className="h-3.5 w-3.5 shrink-0 text-[#8a8a8a]" />;
    case "failed":
      return <X className="h-3.5 w-3.5 shrink-0 text-red-400" />;
    case "stopped":
      return <Ban className="h-3.5 w-3.5 shrink-0 text-[#8a8a8a]" />;
  }
}
