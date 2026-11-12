import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import type { Session } from "@/types";
import { useChatHost } from "../host";
import { HoverCard } from "./HoverCard";
import {
  SUBAGENT_LINE_LABELS,
  SUBAGENT_STATUS_LABELS,
  subagentMeta,
  subagentTitle,
  subagentUsage,
  type SubagentEvent,
} from "./subagent-display";
import type { EventViewProps } from "./types";
import { useAgentIdentity, useEventAgent } from "./use-agent-identity";

/** 子 Agent 在原位置更新状态，点开看它自己的过程。 */
export function SubagentLine({ event, session }: EventViewProps) {
  if (event.kind !== "subagent") return null;
  const title = subagentTitle(event);
  return (
    <Line event={event} session={session} subagentId={event.subagent_id} state={event.status}>
      <HoverCard content={<SubagentDetails card={event} />}>
        <span className={cn("min-w-0 truncate", event.status === "failed" && "text-wb-danger")}>
          {title}{SUBAGENT_LINE_LABELS[event.status]}
        </span>
      </HoverCard>
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
  const rowClass = "flex min-w-0 max-w-full items-center gap-2 text-left text-[13px] text-wb-fg-2";
  return (
    <div className="event-in min-w-0 px-6 py-1" data-subagent-line={subagentId} data-subagent-state={state}>
      <div className="min-w-0 pl-6">
        {open ? (
          <button
            type="button"
            onClick={() => open(event.session_id, subagentId)}
            className={cn(rowClass, "rounded transition-colors hover:text-wb-fg")}
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
      <div className="font-medium text-wb-fg">{subagentTitle(card)}</div>
      <div className="text-wb-fg-3">{meta}</div>
      {prompt ? <p className="m-0 line-clamp-4 whitespace-pre-wrap break-words text-wb-fg-2">{prompt}</p> : null}
      {activity ? <p className="m-0 truncate text-wb-fg">{activity}</p> : null}
      {result ? <p className="m-0 line-clamp-4 whitespace-pre-wrap break-words text-wb-fg-2">{result}</p> : null}
      {usage ? <div className="text-wb-fg-3">{usage}</div> : null}
    </div>
  );
}
