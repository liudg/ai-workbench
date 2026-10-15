import { useEffect, useMemo, useState } from "react";
import { MessageSquareDashed } from "lucide-react";

import { useChangeCapabilities } from "@/features/changes-model/use-changes";
import { showsFileChanges } from "@/features/changes-model/capabilities";
import { lastSlice, turnChanges } from "@/features/changes-model/diff-parse";
import { pendingPrompt } from "@/lib/utils";
import { SessionAgentIcon } from "@/features/sidebar/sessions/SessionAgentIcon";
import { type Session, type SessionEvent } from "@/types";
import { agentTurnName, useAgentIdentity } from "../events/use-agent-identity";
import { ChangeCard } from "../cards/ChangeCard";
import { Composer } from "../composer/Composer";
import { EventItem } from "../events/EventItem";
import { pendingQuestionEvent } from "../events/pending-question";
import { QuestionPopup } from "../events/QuestionPopup";
import { ActivityStream } from "./ActivityStream";
import { LiveTurn } from "./LiveTurn";
import { TurnFoldLine } from "./TurnFoldLine";
import { TurnProcess } from "./TurnProcess";
import {
  buildTimeline,
  contentChars,
  runningTurnSummary,
  timelineStatus,
  type TimelineNode,
} from "./timeline";
import { useTimelineFollow } from "./useTimelineFollow";

export function ChatView({
  session,
  events,
}: {
  session: Session;
  events: SessionEvent[];
}) {
  const pendingId = useMemo(() => pendingPrompt(events), [events]);
  const questionEvent = useMemo(
    () => pendingQuestionEvent(events, session.status),
    [events, session.status],
  );
  const [questionAnchor, setQuestionAnchor] = useState<HTMLDivElement | null>(null);
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
  const identity = useAgentIdentity(session.agent);
  const agentName = agentTurnName(session.agent, identity);
  const changeFlags = useChangeCapabilities(session.agent);
  const liveChanges = useMemo(() => {
    if (!showsFileChanges(changeFlags)) return null;
    if (status !== "running" && status !== "needs-input") return null;
    return turnChanges(lastSlice(events));
  }, [changeFlags, events, status]);

  const [liveOverrides, setLiveOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [foldOverrides, setFoldOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  useEffect(() => {
    setLiveOverrides(new Map());
    setFoldOverrides(new Map());
  }, [session.id]);
  const chunks = useMemo(() => chunkTimeline(blocks), [blocks]);

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
        <div ref={contentRef} data-message-column className="mx-auto min-h-full w-full min-w-0 max-w-[760px]">
          {!hasVisibleEvent ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-600">
              <MessageSquareDashed className="h-8 w-8" strokeWidth={1.5} />
              <p className="text-sm">发送第一条消息，开始这轮会话</p>
            </div>
          ) : (
            chunks.map((chunk) => {
              if (chunk.type === "events") {
                return (
                  <ActivityStream
                    key={`events-${chunk.id}`}
                    events={chunk.events}
                    session={session}
                    resolvedAnswers={resolvedAnswers}
                    showAgentLabel={(event) => chunk.labels.get(event.id) ?? false}
                    onInteract={pausePinForToggle}
                  />
                );
              }
              const block = chunk.block;
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
                    onInteract={pausePinForToggle}
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
                    onInteract={pausePinForToggle}
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
                    event.kind === "prompt" ? (resolvedAnswers.get(event.prompt_id) ?? null) : null
                  }
                  showAgentLabel={block.showAgentLabel}
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
                summary={runningTurnSummary(agentName)}
                expanded={expanded}
                icon={<SessionAgentIcon identity={identity} className="h-4 w-4" />}
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
      <div data-composer-column className="mx-auto w-full max-w-[760px]">
        <Composer
          key={session.id}
          session={session}
          events={events}
          anchorRef={setQuestionAnchor}
        />
      </div>
      {questionEvent ? (
        <QuestionPopup
          key={questionEvent.prompt_id}
          event={questionEvent}
          sessionId={session.id}
          anchor={questionAnchor}
        />
      ) : null}
      {pendingId && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-amber-400/60 to-transparent" />
      )}
    </>
  );
}

type TimelineChunk =
  | { type: "events"; id: string; events: SessionEvent[]; labels: ReadonlyMap<string, boolean> }
  | { type: "block"; block: TimelineNode };

/** 用户消息、已结束的一轮和进行中的一轮各自断开。中间的事件交给活动流。 */
function chunkTimeline(blocks: readonly TimelineNode[]): TimelineChunk[] {
  const chunks: TimelineChunk[] = [];
  let events: SessionEvent[] = [];
  let labels = new Map<string, boolean>();
  const flush = () => {
    if (events.length === 0) return;
    chunks.push({ type: "events", id: events[0].id, events, labels });
    events = [];
    labels = new Map();
  };
  for (const block of blocks) {
    if (block.type === "event" && block.event.kind !== "user-message") {
      events.push(block.event);
      labels.set(block.event.id, block.showAgentLabel);
      continue;
    }
    flush();
    chunks.push({ type: "block", block });
  }
  flush();
  return chunks;
}
