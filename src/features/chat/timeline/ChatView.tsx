import { useEffect, useMemo, useState } from "react";
import { MessageSquareDashed } from "lucide-react";

import { useChangeCapabilities } from "@/features/changes-model/use-changes";
import { showsFileChanges } from "@/features/changes-model/capabilities";
import { lastSlice, turnChanges } from "@/features/changes-model/diff-parse";
import { pendingPrompt } from "@/lib/utils";
import { AGENT_LABELS, type Session, type SessionEvent } from "@/types";
import { ChangeCard } from "../cards/ChangeCard";
import { Composer } from "../composer/Composer";
import { EventItem } from "../events/EventItem";
import { LiveTurn } from "./LiveTurn";
import { TurnFoldLine } from "./TurnFoldLine";
import { TurnProcess } from "./TurnProcess";
import { buildTimeline, contentChars, runningTurnSummary, timelineStatus } from "./timeline";
import { useTimelineFollow } from "./useTimelineFollow";

export function ChatView({
  session,
  events,
}: {
  session: Session;
  events: SessionEvent[];
}) {
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
  const changeFlags = useChangeCapabilities(session.agent);
  const liveChanges = useMemo(() => {
    if (!showsFileChanges(changeFlags)) return null;
    if (status !== "running" && status !== "needs-input") return null;
    return turnChanges(lastSlice(events));
  }, [changeFlags, events, status]);

  const [liveOverrides, setLiveOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [foldOverrides, setFoldOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [thinkingOverrides, setThinkingOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  useEffect(() => {
    setLiveOverrides(new Map());
    setFoldOverrides(new Map());
    setThinkingOverrides(new Map());
  }, [session.id]);

  const {
    scrollRef,
    contentRef,
    onTimelineScroll,
    onTimelineWheel,
    onPointerDown,
    pausePinForToggle,
  } = useTimelineFollow(session.id, layoutKey);

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
                    event.kind === "prompt" ? (resolvedAnswers.get(event.prompt_id) ?? null) : null
                  }
                  showAgentLabel={block.showAgentLabel}
                  thinkingOpen={thinkingOpen}
                  onToggleThinking={
                    event.kind === "thinking"
                      ? () => {
                          pausePinForToggle();
                          setThinkingOverrides((prev) => new Map(prev).set(event.id, !thinkingOpen));
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
      {pendingId && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-amber-400/60 to-transparent" />
      )}
    </>
  );
}
