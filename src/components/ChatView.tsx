import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquareDashed } from "lucide-react";

import { pendingPrompt } from "@/lib/utils";
import type { Session, SessionEvent } from "@/types";
import { Composer } from "./Composer";
import { EventItem } from "./EventItem";
import { WorkDetailsGroup } from "./WorkDetailsGroup";

type TimelineBlock =
  | { type: "event"; event: SessionEvent }
  | { type: "work"; id: string; events: SessionEvent[] };

/** 连续的工具调用并成一个折叠组；status-changed / prompt-resolved 不渲染。 */
function buildBlocks(events: SessionEvent[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  for (const event of events) {
    if (event.kind === "status-changed" || event.kind === "prompt-resolved") {
      continue;
    }
    if (event.kind === "tool-call") {
      const last = blocks[blocks.length - 1];
      if (last && last.type === "work") {
        last.events.push(event);
      } else {
        blocks.push({ type: "work", id: event.id, events: [event] });
      }
    } else {
      blocks.push({ type: "event", event });
    }
  }
  return blocks;
}

export function ChatView({
  session,
  events,
}: {
  session: Session;
  events: SessionEvent[];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const pendingId = useMemo(() => pendingPrompt(events), [events]);
  const resolvedAnswers = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of events) {
      if (e.kind === "prompt-resolved") map.set(e.prompt_id, e.answer);
    }
    return map;
  }, [events]);

  const blocks = useMemo(() => buildBlocks(events), [events]);
  // 用户手动展开 / 折叠的组优先于默认行为（运行中展开、结束后折叠）
  const [workOverrides, setWorkOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(new Map());
  useEffect(() => setWorkOverrides(new Map()), [session.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [events.length, session.id]);

  return (
    <>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto py-4"
      >
        {events.filter((e) => e.kind !== "status-changed").length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-600">
            <MessageSquareDashed className="h-8 w-8" strokeWidth={1.5} />
            <p className="text-sm">发送第一条消息，开始这轮会话</p>
          </div>
        ) : (
          blocks.map((block, index) => {
            if (block.type === "work") {
              const live =
                index === blocks.length - 1 && session.status === "running";
              const expanded = workOverrides.get(block.id) ?? live;
              return (
                <WorkDetailsGroup
                  key={block.id}
                  events={block.events}
                  session={session}
                  live={live}
                  expanded={expanded}
                  onToggle={() =>
                    setWorkOverrides((prev) =>
                      new Map(prev).set(block.id, !expanded),
                    )
                  }
                />
              );
            }
            const event = block.event;
            return (
              <EventItem
                key={event.id}
                event={event}
                session={session}
                resolvedAnswer={
                  event.kind === "prompt"
                    ? (resolvedAnswers.get(event.prompt_id) ?? null)
                    : null
                }
              />
            );
          })
        )}
        {session.status === "running" && (
          <div className="px-6 py-2">
            <div className="mx-auto flex max-w-3xl items-center gap-2 pl-6 text-xs text-zinc-500">
              <span className="flex gap-1">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-500 [animation-delay:0ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-500 [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-500 [animation-delay:300ms]" />
              </span>
              正在处理…
            </div>
          </div>
        )}
      </div>
      <Composer session={session} events={events} />
      {pendingId && session.status === "needs-input" && (
        <div className="pointer-events-none absolute inset-x-0 top-12 h-0.5 bg-gradient-to-r from-transparent via-amber-400/60 to-transparent" />
      )}
    </>
  );
}
