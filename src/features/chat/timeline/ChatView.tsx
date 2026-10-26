import { useEffect, useMemo, useState, type ReactNode, type Ref } from "react";
import { MessageSquareDashed } from "lucide-react";

import { useChangeCapabilities } from "../use-change-capabilities";
import { showsFileChanges } from "@/features/changes-model/capabilities";
import { lastSlice, turnChanges } from "@/features/changes-model/diff-parse";
import { pendingPrompt } from "@/lib/utils";
import { type Session, type SessionEvent } from "@/types";
import { ChangeCard } from "../cards/ChangeCard";
import { EventItem } from "../events/EventItem";
import { pendingQuestionEvent } from "../events/pending-question";
import { pendingApprovalEvent } from "../events/pending-approval";
import { pendingPlanChoice } from "../events/pending-plan-choice";
import { ApprovalSurface } from "../events/ApprovalSurface";
import { PlanChoiceSurface } from "../events/PlanChoiceSurface";
import { QuestionPopup } from "../events/QuestionPopup";
import { ActivityStream } from "./ActivityStream";
import { LiveTurn } from "./LiveTurn";
import { TurnProcess } from "./TurnProcess";
import {
  buildTimeline,
  chunkTimeline,
  contentChars,
  timelineChunkKey,
  timelineStatus,
} from "./timeline";
import { FindBar } from "../find/FindBar";
import { useThreadFind } from "../find/use-thread-find";
import { ChatSelectionMenu } from "./ChatSelectionMenu";
import { ChatErrorBoundary } from "./ChatErrorBoundary";
import { useHistoryEnter } from "./useHistoryEnter";
import { useTimelineFollow } from "./useTimelineFollow";
import { useTurnVirtualizer } from "./useTurnVirtualizer";

const EMPTY_CHUNK_KEYS: readonly string[] = [];

/** 作曲栏由宿主给出。`anchorRef` 接到输入框外框上，提问浮层贴着它摆。 */
export type RenderComposer = (anchorRef: Ref<HTMLDivElement>) => ReactNode;

export function ChatView({
  session,
  events,
  eventsReady = true,
  renderComposer,
}: {
  session: Session;
  events: SessionEvent[];
  /** 选中会话的历史还没回来时为 false。预览直接给了事件，默认已就绪。 */
  eventsReady?: boolean;
  renderComposer: RenderComposer;
}) {
  return (
    <ChatErrorBoundary resetKey={session.id}>
      <ChatTimeline
        session={session}
        events={events}
        eventsReady={eventsReady}
        renderComposer={renderComposer}
      />
    </ChatErrorBoundary>
  );
}

function ChatTimeline({
  session,
  events,
  eventsReady,
  renderComposer,
}: {
  session: Session;
  events: SessionEvent[];
  eventsReady: boolean;
  renderComposer: RenderComposer;
}) {
  const pendingId = useMemo(() => pendingPrompt(events), [events]);
  const questionEvent = useMemo(
    () => pendingQuestionEvent(events, session.status),
    [events, session.status],
  );
  const approvalEvent = useMemo(
    () => pendingApprovalEvent(events, session.status),
    [events, session.status],
  );
  const planChoice = useMemo(
    () => pendingPlanChoice(events, session.status),
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
  const chunkKeys = useMemo(() => chunks.map((chunk) => timelineChunkKey(chunk)), [chunks]);
  const trackedKeys = eventsReady ? chunkKeys : EMPTY_CHUNK_KEYS;
  const entering = useHistoryEnter(session.id, trackedKeys);

  const {
    scrollRef,
    contentRef,
    onTimelineScroll,
    onTimelineWheel,
    onPointerDown,
    pausePinForToggle,
    ...anchor
  } = useTimelineFollow(session.id, layoutKey);
  const find = useThreadFind(scrollRef, layoutKey);
  const virtual = useTurnVirtualizer({
    sessionId: session.id,
    keys: trackedKeys,
    anchor: { scrollRef, ...anchor },
    revealAll: find.open,
  });

  const renderChunk = (chunk: (typeof chunks)[number]): ReactNode => {
    if (chunk.type === "events") {
      return (
        <ActivityStream
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
          events={block.events}
          session={session}
          resolvedAnswers={resolvedAnswers}
          expanded={expanded}
          onInteract={pausePinForToggle}
          onToggle={() => {
            pausePinForToggle();
            setLiveOverrides((prev) => new Map(prev).set(block.id, !expanded));
          }}
        />
      );
    }
    const event = block.event;
    return (
      <EventItem
        event={event}
        session={session}
        resolvedAnswer={event.kind === "prompt" ? (resolvedAnswers.get(event.prompt_id) ?? null) : null}
        showAgentLabel={block.showAgentLabel}
      />
    );
  };

  return (
    <>
      {find.open ? (
        <FindBar
          query={find.query}
          count={find.count}
          index={find.index}
          inputRef={find.inputRef}
          onQuery={find.onQuery}
          onNext={find.onNext}
          onPrevious={find.onPrevious}
          onClose={find.close}
        />
      ) : null}
      <div
        ref={scrollRef}
        onScroll={onTimelineScroll}
        onWheel={onTimelineWheel}
        onPointerDown={onPointerDown}
        className="chat-log min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto py-4"
      >
        <div ref={contentRef} data-message-column className="mx-auto min-h-full w-full min-w-0 max-w-[760px]">
          {!eventsReady ? (
            <div className="min-h-full" data-history-pending />
          ) : !hasVisibleEvent ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-600">
              <MessageSquareDashed className="h-8 w-8" strokeWidth={1.5} />
              <p className="text-sm">发送第一条消息，开始这轮会话</p>
            </div>
          ) : (
            <div className="turn-virtual-list" style={{ position: "relative", height: virtual.totalHeight, width: "100%" }}>
              {chunks.slice(virtual.start, virtual.end).map((chunk, offset) => {
                const index = virtual.start + offset;
                const key = chunkKeys[index] ?? timelineChunkKey(chunk);
                return (
                  <div
                    key={key}
                    data-turn-key={key}
                    ref={virtual.refFor(key)}
                    className={entering.has(key) ? "turn-virtual-item" : "turn-virtual-item enter-static"}
                    style={{ position: "absolute", top: virtual.prefix[index] ?? 0, left: 0, width: "100%" }}
                  >
                    {renderChunk(chunk)}
                  </div>
                );
              })}
            </div>
          )}
          {eventsReady && liveChanges ? <ChangeCard changes={liveChanges} defaultExpanded /> : null}
        </div>
      </div>
      <ChatSelectionMenu rootRef={scrollRef} sessionId={session.id} />
      <div data-composer-column className="mx-auto w-full max-w-[760px]">
        {approvalEvent ? (
          <ApprovalSurface key={approvalEvent.prompt_id} event={approvalEvent} sessionId={session.id} />
        ) : null}
        {planChoice ? (
          <PlanChoiceSurface key={planChoice.prompt_id} event={planChoice} session={session} />
        ) : null}
        {renderComposer(setQuestionAnchor)}
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
