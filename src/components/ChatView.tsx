import { useEffect, useMemo, useRef } from "react";
import { MessageSquareDashed } from "lucide-react";

import { pendingPrompt } from "@/lib/utils";
import type { Session, SessionEvent } from "@/types";
import { Composer } from "./Composer";
import { EventItem } from "./EventItem";

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
          events.map((event) => (
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
          ))
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
