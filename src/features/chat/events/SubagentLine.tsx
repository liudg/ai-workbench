import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import type { Session } from "@/types";
import { useChatHost } from "../host";
import { HoverCard } from "./HoverCard";
import {
  SUBAGENT_END_LABELS,
  SUBAGENT_STATUS_LABELS,
  subagentMeta,
  subagentTitle,
  subagentUsage,
  type SubagentEvent,
} from "./subagent-display";
import type { EventViewProps } from "./types";
import { useAgentIdentity, useEventAgent } from "./use-agent-identity";

/** Agent 自带子 Agent 在时间线里的两行：开始工作和结束，各在发生的位置，跟着过程一起折叠。点开看它自己的过程。 */
export function SubagentStartLine({ event, session }: EventViewProps) {
  if (event.kind !== "subagent") return null;
  const title = subagentTitle(event);
  return (
    <Line event={event} session={session} subagentId={event.subagent_id} state="started">
      <HoverCard content={<SubagentDetails card={event} />}>
        <span className="min-w-0 truncate">{title}开始工作</span>
      </HoverCard>
    </Line>
  );
}

export function SubagentEndLine({ event, session }: EventViewProps) {
  if (event.kind !== "subagent-ended") return null;
  return (
    <Line event={event} session={session} subagentId={event.subagent_id} state={event.status}>
      <span className={cn("min-w-0 truncate", event.status === "failed" && "text-red-400/90")}>
        {event.title.trim() || "子 Agent"}
        {SUBAGENT_END_LABELS[event.status]}
      </span>
    </Line>
  );
}

function Line({
  event,
  session,
  subagentId,
  state,
  children,
}: {
  event: EventViewProps["event"];
  session: Session;
  subagentId: string;
  state: string;
  children: ReactNode;
}) {
  const open = useChatHost().openSubagent;
  const identity = useAgentIdentity(useEventAgent(event, session));
  const content = (
    <>
      <SessionAgentIcon identity={identity} className="h-4 w-4" />
      {children}
    </>
  );
  const rowClass = "flex min-w-0 max-w-full items-center gap-2 text-left text-[13px] text-[#8a8a8a]";
  return (
    <div className="event-in min-w-0 px-6 py-1" data-subagent-line={subagentId} data-subagent-state={state}>
      <div className="min-w-0 pl-6">
        {open ? (
          <button
            type="button"
            onClick={() => open(event.session_id, subagentId)}
            className={cn(rowClass, "rounded hover:text-[#d4d4d4]")}
          >
            {content}
          </button>
        ) : (
          <div className={rowClass}>{content}</div>
        )}
      </div>
    </div>
  );
}

/** 悬停卡片：说明、正在做的、结果和用量。 */
function SubagentDetails({ card }: { card: SubagentEvent }) {
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
