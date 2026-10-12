import { useEffect, useLayoutEffect, useMemo, useRef, useState, type WheelEvent } from "react";
import { MessageSquareDashed } from "lucide-react";

import { pendingPrompt } from "@/lib/utils";
import { useWorkbench } from "@/store";
import { AGENT_LABELS, type Session, type SessionEvent } from "@/types";
import { showsFileChanges } from "@/features/changes-model/capabilities";
import { lastSlice, turnChanges } from "@/features/changes-model/diff-parse";
import { ChangeCard } from "../cards/ChangeCard";
import { Composer } from "../composer/Composer";
import { EventItem } from "../events/EventItem";
import { buildTimeline, runningTurnSummary, timelineStatus } from "./timeline";
import { LiveTurn } from "./LiveTurn";
import { TurnFoldLine } from "./TurnFoldLine";
import { TurnProcess } from "./TurnProcess";

const NEAR_BOTTOM_PX = 80;

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
        chars += event.summary.length + (event.detail?.length ?? 0);
        break;
      case "error":
        chars += event.message.length;
        break;
      case "prompt":
        chars += event.question.length;
        break;
      case "file-change":
        chars += event.diff.length;
        break;
      case "turn-changes":
        chars += event.files.reduce((sum, file) => sum + file.diff.length, 0);
        break;
      case "plan-steps":
        chars += (event.explanation?.length ?? 0) + event.steps.reduce((sum, step) => sum + step.step.length, 0);
        break;
      case "plan-text":
      case "review-note":
        chars += event.text.length;
        break;
      case "review-findings":
        chars += event.summary.length + event.findings.reduce((sum, finding) => sum + finding.body.length, 0);
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
  const historyExhausted = useRef(false);
  const historyLoading = useRef(false);
  const loadOlderHistory = useWorkbench((s) => s.loadOlderHistory);
  const pagedHistory = useWorkbench(
    (s) => s.catalogs[session.id]?.capabilities.supports_paged_history === true,
  );

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
  const blocks = useMemo(() => buildTimeline(events, status), [events, status]);
  const layoutKey = useMemo(
    () => `${events.length}:${contentChars(events)}:${status}`,
    [events, status],
  );
  const hasVisibleEvent = useMemo(
    () => events.some((event) => event.kind !== "status-changed"),
    [events],
  );
  const changeFlags = useWorkbench((state) => state.profiles[session.agent]?.capabilities.changes);
  const liveChanges = useMemo(() => {
    if (!showsFileChanges(changeFlags)) return null;
    if (status !== "running" && status !== "needs-input") return null;
    return turnChanges(lastSlice(events));
  }, [changeFlags, events, status]);

  const [liveOverrides, setLiveOverrides] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [foldOverrides, setFoldOverrides] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [thinkingOverrides, setThinkingOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(new Map());
  useEffect(() => {
    setLiveOverrides(new Map());
    setFoldOverrides(new Map());
    setThinkingOverrides(new Map());
    historyExhausted.current = false;
    historyLoading.current = false;
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

  const requestOlder = () => {
    if (!pagedHistory || historyExhausted.current || historyLoading.current) return;
    const el = scrollRef.current;
    if (!el) return;
    historyLoading.current = true;
    const before = el.scrollHeight;
    const top = el.scrollTop;
    suppressPinRef.current = true;
    followRef.current = false;
    void loadOlderHistory(session.id)
      .then((exhausted) => {
        if (exhausted) historyExhausted.current = true;
        requestAnimationFrame(() => {
          const node = scrollRef.current;
          if (node) node.scrollTop = top + Math.max(0, node.scrollHeight - before);
          requestAnimationFrame(() => {
            suppressPinRef.current = false;
            historyLoading.current = false;
          });
        });
      })
      .catch(() => {
        suppressPinRef.current = false;
        historyLoading.current = false;
      });
  };

  const onTimelineScroll = () => {
    const el = scrollRef.current;
    if (!el || pinningRef.current) return;
    followRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (el.scrollTop < 48) requestOlder();
  };

  const onTimelineWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY >= 0) return;
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop < 48) requestOlder();
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
          {!hasVisibleEvent ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-600">
              <MessageSquareDashed className="h-8 w-8" strokeWidth={1.5} />
              <p className="text-sm">发送第一条消息，开始这轮会话</p>
            </div>
          ) : (
            blocks.map((block) => {
              if (block.type === "turn") {
                const expanded = foldOverrides.get(block.id) ?? false;
                return (
                  <TurnProcess
                    key={block.id}
                    events={block.events}
                    answerId={block.answerId}
                    durationMs={block.durationMs}
                    session={session}
                    resolvedAnswers={resolvedAnswers}
                    expanded={expanded}
                    onToggle={() => {
                      pausePinForToggle();
                      setFoldOverrides((prev) => new Map(prev).set(block.id, !expanded));
                    }}
                  />
                );
              }
              if (block.type === "live") {
                const expanded = liveOverrides.get(block.id) ?? true;
                return (
                  <LiveTurn
                    key={block.id}
                    events={block.events}
                    session={session}
                    resolvedAnswers={resolvedAnswers}
                    expanded={expanded}
                  />
                );
              }
              const event = block.event;
              const thinkingOpen =
                event.kind === "thinking" ? (thinkingOverrides.get(event.id) ?? false) : undefined;
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
                  showAgentLabel={block.showAgentLabel}
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
          {liveChanges ? <ChangeCard changes={liveChanges} /> : null}
          {blocks.map((block) => {
            if (block.type !== "live") return null;
            const expanded = liveOverrides.get(block.id) ?? true;
            return (
              <TurnFoldLine
                key={`${block.id}-status`}
                summary={runningTurnSummary(AGENT_LABELS[session.agent])}
                expanded={expanded}
                showAgentIcon
                pulse
                onToggle={() => {
                  pausePinForToggle();
                  setLiveOverrides((prev) => new Map(prev).set(block.id, !expanded));
                }}
              />
            );
          })}
        </div>
      </div>
      <Composer key={session.id} session={session} events={events} />
      {pendingId && status === "needs-input" && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-amber-400/60 to-transparent" />
      )}
    </>
  );
}
