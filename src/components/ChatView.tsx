import { useEffect, useLayoutEffect, useMemo, useRef, useState, type WheelEvent } from "react";
import { MessageSquareDashed } from "lucide-react";

import { timelineStatus, turnDetailsOpen } from "@/lib/timeline";
import { pendingPrompt } from "@/lib/utils";
import type { Session, SessionEvent } from "@/types";
import { Composer } from "./Composer";
import { EventItem } from "./EventItem";
import { WorkDetailsGroup } from "./WorkDetailsGroup";

type TimelineBlock =
  | { type: "event"; event: SessionEvent }
  | { type: "work"; id: string; events: SessionEvent[] };

const NEAR_BOTTOM_PX = 80;

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

function contentChars(events: SessionEvent[]): number {
  let chars = 0;
  for (const event of events) {
    switch (event.kind) {
      case "user-message":
      case "agent-message":
      case "thinking":
      case "system":
      case "read-only":
        chars += event.text.length;
        break;
      case "tool-call":
        chars += event.summary.length;
        break;
      case "error":
        chars += event.message.length;
        break;
      case "prompt":
        chars += event.question.length;
        break;
      default:
        break;
    }
  }
  return chars;
}

export function ChatView({
  session,
  events,
}: {
  session: Session;
  events: SessionEvent[];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const pinningRef = useRef(false);
  const suppressPinRef = useRef(false);
  const interactingRef = useRef(false);
  const pointerStopRef = useRef<(() => void) | null>(null);
  const seenSession = useRef(session.id);

  const pendingId = useMemo(() => pendingPrompt(events), [events]);
  const resolvedAnswers = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of events) {
      if (e.kind === "prompt-resolved") map.set(e.prompt_id, e.answer);
    }
    return map;
  }, [events]);

  const status = useMemo(
    () => timelineStatus(events, session.status),
    [events, session.status],
  );
  const blocks = useMemo(() => buildBlocks(events), [events]);
  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    events.forEach((event, index) => map.set(event.id, index));
    return map;
  }, [events]);
  const layoutKey = `${events.length}:${contentChars(events)}:${status}`;

  const [workOverrides, setWorkOverrides] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [thinkingOverrides, setThinkingOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(new Map());
  useEffect(() => {
    setWorkOverrides(new Map());
    setThinkingOverrides(new Map());
  }, [session.id]);

  const pinRef = useRef(() => {});
  pinRef.current = () => {
    if (suppressPinRef.current || interactingRef.current || !followRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const top = Math.max(0, el.scrollHeight - el.clientHeight);
    if (el.scrollTop >= top - 1) return;
    pinningRef.current = true;
    el.scrollTop = top;
    requestAnimationFrame(() => {
      pinningRef.current = false;
    });
  };

  useLayoutEffect(() => {
    if (seenSession.current !== session.id) {
      seenSession.current = session.id;
      followRef.current = true;
    }
    pinRef.current();
  }, [session.id, layoutKey]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => pinRef.current());
    observer.observe(content);
    return () => observer.disconnect();
  }, [session.id]);

  useEffect(() => {
    return () => {
      const stop = pointerStopRef.current;
      if (!stop) return;
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  const onTimelineScroll = () => {
    const el = scrollRef.current;
    if (!el || pinningRef.current) return;
    followRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  const onTimelineWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY >= 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const pixels =
      event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * el.clientHeight
          : event.deltaY;
    const nextTop = Math.max(0, el.scrollTop + pixels);
    const nextDistance = el.scrollHeight - nextTop - el.clientHeight;
    if (nextDistance >= NEAR_BOTTOM_PX) followRef.current = false;
  };

  const onPointerDown = () => {
    interactingRef.current = true;
    if (pointerStopRef.current) return;
    const stop = () => {
      interactingRef.current = false;
      pointerStopRef.current = null;
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    pointerStopRef.current = stop;
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const pausePinForToggle = () => {
    suppressPinRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        suppressPinRef.current = false;
      });
    });
  };

  return (
    <>
      <div
        ref={scrollRef}
        onScroll={onTimelineScroll}
        onWheel={onTimelineWheel}
        onPointerDown={onPointerDown}
        className="chat-log min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto py-4"
      >
        <div ref={contentRef} className="min-h-full min-w-0">
          {events.filter((e) => e.kind !== "status-changed").length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-600">
              <MessageSquareDashed className="h-8 w-8" strokeWidth={1.5} />
              <p className="text-sm">发送第一条消息，开始这轮会话</p>
            </div>
          ) : (
            blocks.map((block, index) => {
              if (block.type === "work") {
                const eventIndex = indexById.get(block.events[0].id) ?? -1;
                const live = index === blocks.length - 1 && status === "running";
                const expanded =
                  workOverrides.get(block.id) ??
                  turnDetailsOpen(events, status, eventIndex);
                return (
                  <WorkDetailsGroup
                    key={block.id}
                    events={block.events}
                    session={session}
                    live={live}
                    expanded={expanded}
                    onToggle={() => {
                      pausePinForToggle();
                      setWorkOverrides((prev) => new Map(prev).set(block.id, !expanded));
                    }}
                  />
                );
              }
              const event = block.event;
              const thinkingOpen =
                event.kind === "thinking"
                  ? (thinkingOverrides.get(event.id) ??
                    turnDetailsOpen(events, status, indexById.get(event.id) ?? -1))
                  : undefined;
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
                  thinkingOpen={thinkingOpen}
                  onToggleThinking={
                    event.kind === "thinking"
                      ? () => {
                          pausePinForToggle();
                          setThinkingOverrides((prev) =>
                            new Map(prev).set(event.id, !thinkingOpen),
                          );
                        }
                      : undefined
                  }
                />
              );
            })
          )}
          {status === "running" && (
            <div className="min-w-0 px-6 py-2">
              <div className="mx-auto flex min-w-0 max-w-3xl items-center gap-2 pl-6 text-xs text-zinc-500">
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
      </div>
      <Composer key={session.id} session={session} events={events} />
      {pendingId && status === "needs-input" && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-amber-400/60 to-transparent" />
      )}
    </>
  );
}
