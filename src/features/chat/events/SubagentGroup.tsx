import { useState } from "react";
import { Ban, Bot, Check, ChevronRight, Loader2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Session, SubagentStatus } from "@/types";
import { AssistantAnswer } from "../answer/AssistantAnswer";
import { ActivityStream } from "../timeline/ActivityStream";
import { formatElapsed } from "../timeline/timeline";
import { useElapsedSince } from "../timeline/useElapsedSince";
import {
  SUBAGENT_STATUS_LABELS,
  subagentElapsed,
  subagentGroupSummary,
  subagentMeta,
  subagentResultShown,
  subagentTitle,
  subagentUsage,
  type SubagentEvent,
} from "./subagent-display";
import { useSubagentSteps } from "./subagent-steps";
import type { EventViewProps } from "./types";

const NO_ANSWERS: ReadonlyMap<string, string> = new Map();

/**
 * Agent 自带的子 Agent。一个时就是一行卡片；同一处派出多个时收成一组，组头汇总各状态。
 * 点开一行看派给它的说明、它自己的过程和交回的结果。
 * 照 t3code `apps/web/src/components/chat/TimelineV2EventRow.tsx` 的 `V2SubagentGroup`。
 */
export function SubagentGroup({ cards, session }: { cards: SubagentEvent[]; session: Session }) {
  const running = cards.some((card) => card.status === "running");
  return (
    <div className="event-in min-w-0 px-6 py-1" data-subagent-group={cards.length}>
      <div className="min-w-0 pl-6">
        <div className="overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#1a1a1a]">
          {cards.length > 1 ? (
            <div
              data-subagent-summary
              className="flex min-w-0 items-center gap-2.5 border-b border-[#2a2a2a] px-3 py-2 text-[13px] text-[#9a9a9a]"
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#8fb4ff] motion-reduce:animate-none" />
              ) : (
                <Bot className="h-3.5 w-3.5 shrink-0 text-[#8a8a8a]" />
              )}
              <span className="min-w-0 flex-1 truncate">{subagentGroupSummary(cards)}</span>
            </div>
          ) : null}
          <ul className="m-0 list-none p-0">
            {cards.map((card, index) => (
              <SubagentRow key={card.subagent_id} card={card} session={session} divided={index > 0} />
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

function SubagentRow({ card, session, divided }: { card: SubagentEvent; session: Session; divided: boolean }) {
  const [open, setOpen] = useState(false);
  const steps = useSubagentSteps(card.subagent_id);
  const running = card.status === "running";
  const ticking = useElapsedSince(running ? (card.started_at ?? null) : null);
  const elapsed = running && ticking != null ? ticking : subagentElapsed(card, Date.now());
  const title = subagentTitle(card);
  const meta = subagentMeta(card);
  const usage = subagentUsage(card);
  const prompt = card.prompt?.trim() ?? "";
  // 结果常常就是它最后那句回答，过程里已经有了就不再写一遍。
  const result = subagentResultShown(card, steps);
  const activity = running ? (card.activity?.trim() ?? "") : "";

  return (
    <li
      className={cn(divided && "border-t border-[#2a2a2a]")}
      data-subagent={card.subagent_id}
      data-subagent-status={card.status}
    >
      <button
        type="button"
        data-subagent-toggle
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left text-[13px] text-[#d4d4d4] hover:bg-[#222]"
      >
        <StatusMark status={card.status} />
        <span className="min-w-0 shrink truncate">{title}</span>
        {meta ? <span className="min-w-0 flex-1 truncate text-[12px] text-[#7a7a7a]">{meta}</span> : <span className="flex-1" />}
        {card.background && running ? <span className="shrink-0 text-[12px] text-[#7a7a7a]">后台</span> : null}
        <span
          className={cn("shrink-0 text-[12px]", card.status === "failed" ? "text-red-400/90" : "text-[#8a8a8a]")}
        >
          {elapsed != null && card.status !== "failed"
            ? running
              ? formatElapsed(elapsed)
              : `${SUBAGENT_STATUS_LABELS[card.status]} · ${formatElapsed(elapsed)}`
            : SUBAGENT_STATUS_LABELS[card.status]}
        </span>
        <ChevronRight className={cn("h-4 w-4 shrink-0 text-[#777] transition-transform", open && "rotate-90")} />
      </button>
      {activity && !open ? (
        <div className="truncate px-3 pb-2 pl-9 text-[12px] text-[#8a8a8a]" data-subagent-activity>
          {activity}
        </div>
      ) : null}
      {open ? (
        <div data-subagent-body className="min-w-0 border-t border-[#2a2a2a] pb-2">
          {prompt ? (
            <p className="m-0 line-clamp-4 whitespace-pre-wrap break-words px-3 pt-2 pl-9 text-[12px] leading-5 text-[#8a8a8a]">
              {prompt}
            </p>
          ) : null}
          {steps.length > 0 ? (
            <div className="-mx-3 min-w-0 pt-1">
              <ActivityStream
                events={steps}
                session={session}
                resolvedAnswers={NO_ANSWERS}
                showAgentLabel={() => false}
                live={running}
                settled={!running}
              />
            </div>
          ) : null}
          {activity ? <div className="px-3 pt-1 pl-9 text-[12px] text-[#8a8a8a]">{activity}</div> : null}
          {result ? (
            <div className="min-w-0 px-3 pt-2 pl-9" data-subagent-result>
              <AssistantAnswer text={result} />
            </div>
          ) : null}
          {usage ? <div className="px-3 pt-1 pl-9 text-[12px] text-[#7a7a7a]">{usage}</div> : null}
        </div>
      ) : null}
    </li>
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
