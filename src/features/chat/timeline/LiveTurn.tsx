import { useState } from "react";

import type { Session, SessionEvent } from "@/types";
import { EventItem } from "../events/EventItem";
import { pickAnswer } from "./timeline";

/**
 * 进行中的一轮里已经写出来的过程。工具调用各自一行，思考默认收起。
 * 「正在处理」折叠行由时间线放在变更卡片之后，留在对话末尾。
 */
export function LiveTurn({
  events,
  session,
  resolvedAnswers,
  expanded,
}: {
  events: SessionEvent[];
  session: Session;
  resolvedAnswers: ReadonlyMap<string, string>;
  expanded: boolean;
}) {
  const [thinkingOpenIds, setThinkingOpenIds] = useState<ReadonlySet<string>>(new Set());
  const answer = pickAnswer(events, false);

  return (
    <div className="min-w-0" data-live-turn>
      {expanded
        ? events.map((event) => (
            <EventItem
              key={event.id}
              event={event}
              session={session}
              resolvedAnswer={
                event.kind === "prompt" ? (resolvedAnswers.get(event.prompt_id) ?? null) : null
              }
              showAgentLabel={answer != null && event.id === answer.id}
              thinkingOpen={event.kind === "thinking" ? thinkingOpenIds.has(event.id) : undefined}
              onToggleThinking={
                event.kind === "thinking"
                  ? () => {
                      setThinkingOpenIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(event.id)) next.delete(event.id);
                        else next.add(event.id);
                        return next;
                      });
                    }
                  : undefined
              }
            />
          ))
        : null}
    </div>
  );
}
