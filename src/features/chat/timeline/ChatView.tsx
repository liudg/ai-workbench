import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";

import { useChangeCapabilities } from "../use-change-capabilities";
import { lastSlice, showsFileChanges, turnChanges } from "@/features/changes-model";
import { cn, pendingPrompt } from "@/lib/utils";
import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import { clearPendingJump, useNavigation } from "@/shared/shell/navigation";
import { type Session, type SessionEvent } from "@/types";
import { ChangeCard } from "../cards/ChangeCard";
import { backgroundTasksByToolCall } from "../events/background-task-display";
import { EventItem } from "../events/EventItem";
import { agentTurnName, useAgentIdentity } from "../events/use-agent-identity";
import { pendingQuestionEvent } from "../events/pending-question";
import { pendingApprovalEvent } from "../events/pending-approval";
import { pendingPlanChoice } from "../events/pending-plan-choice";
import { ApprovalSurface } from "../events/ApprovalSurface";
import { PlanChoiceSurface } from "../events/PlanChoiceSurface";
import { QuestionPopup } from "../events/QuestionPopup";
import { ActivityStream } from "./ActivityStream";
import { LiveStatus } from "./LiveStatus";
import { LiveTurn } from "./LiveTurn";
import { liveActivityLabel } from "../events/tool-status";
import { TurnProcess } from "./TurnProcess";
import {
  buildTimeline,
  chunkTimeline,
  contentChars,
  findTimelineContainerForEvent,
  isEventInTimelineBlocks,
  timelineChunkKey,
  timelineStatus,
} from "./timeline";
import { FindBar } from "../find/FindBar";
import { useThreadFind } from "../find/use-thread-find";
import { useChatHost } from "../host";
import { MessageMenuProvider } from "../message-menu";
import { RewindDialog, type RewindCompletion, type RewindTarget } from "../rewind/RewindDialog";
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
  taskId,
  rewindTarget = null,
  onCloseRewind,
  onRewindComplete,
  renderComposer,
}: {
  session: Session;
  events: SessionEvent[];
  /** 选中会话的历史还没回来时为 false。预览直接给了事件，默认已就绪。 */
  eventsReady?: boolean;
  /** 所属任务 id，用来匹配跨会话全文检索跳转。缺省回退到 `session.id`。 */
  taskId?: string;
  rewindTarget?: RewindTarget | null;
  onCloseRewind?: () => void;
  onRewindComplete?: (result: RewindCompletion) => void;
  renderComposer: RenderComposer;
}) {
  return (
    <ChatErrorBoundary resetKey={session.id}>
      <MessageMenuProvider sessionId={session.id}>
        <ChatTimeline
          session={session}
          events={events}
          eventsReady={eventsReady}
          taskId={taskId}
          rewindTarget={rewindTarget}
          onCloseRewind={onCloseRewind}
          onRewindComplete={onRewindComplete}
          renderComposer={renderComposer}
        />
      </MessageMenuProvider>
    </ChatErrorBoundary>
  );
}

function ChatTimeline({
  session,
  events,
  eventsReady,
  taskId,
  rewindTarget,
  onCloseRewind,
  onRewindComplete,
  renderComposer,
}: {
  session: Session;
  events: SessionEvent[];
  eventsReady: boolean;
  taskId?: string;
  rewindTarget: RewindTarget | null;
  onCloseRewind?: () => void;
  onRewindComplete?: (result: RewindCompletion) => void;
  renderComposer: RenderComposer;
}) {
  const host = useChatHost();
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
  const effectiveSession = useMemo(
    () => (session.status === status ? session : { ...session, status }),
    [session, status],
  );
  const backgroundByToolCall = useMemo(() => backgroundTasksByToolCall(events), [events]);
  const blocks = useMemo(() => buildTimeline(events, status), [events, status]);
  const liveBlock = useMemo(() => blocks.find((block) => block.type === "live") ?? null, [blocks]);
  const layoutKey = useMemo(
    () => `${events.length}:${contentChars(events)}:${status}`,
    [events, status],
  );
  const sessionInstanceId = host.instanceOf?.(session.id);
  const agentIdentity = useAgentIdentity(session.agent, sessionInstanceId);
  const changeFlags = useChangeCapabilities(session.agent, sessionInstanceId);
  const liveChanges = useMemo(() => {
    if (!showsFileChanges(changeFlags)) return null;
    if (status !== "running" && status !== "needs-input") return null;
    return turnChanges(lastSlice(events));
  }, [changeFlags, events, status]);
  const hasVisibleEvent = useMemo(
    () => blocks.length > 0 || liveChanges !== null,
    [blocks.length, liveChanges],
  );

  const [liveOverrides, setLiveOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [foldOverrides, setFoldOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [revealEventId, setRevealEventId] = useState<string | null>(null);
  const [highlightedEventId, setHighlightedEventId] = useState<string | null>(null);
  const [pagingTick, setPagingTick] = useState(0);
  const highlightTimerRef = useRef<number | null>(null);
  const pagingRef = useRef<{
    nonce: number;
    loading: boolean;
    attempts: number;
    exhausted: boolean;
    lastEventsLen: number;
  }>({
    nonce: -1,
    loading: false,
    attempts: 0,
    exhausted: false,
    lastEventsLen: -1,
  });

  useEffect(() => {
    setLiveOverrides(new Map());
    setFoldOverrides(new Map());
    setRevealEventId(null);
    setHighlightedEventId(null);
  }, [session.id]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    };
  }, []);

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
    holdScrollPosition,
    ...anchor
  } = useTimelineFollow(session.id, layoutKey);
  const find = useThreadFind(scrollRef, layoutKey, holdScrollPosition, Boolean(session.project_id));

  const pendingJump = useNavigation((state) => state.pendingJump);
  const ownerTaskId = taskId ?? session.id;
  const jumpingToThisView = Boolean(pendingJump && pendingJump.taskId === ownerTaskId);

  const virtual = useTurnVirtualizer({
    sessionId: session.id,
    keys: trackedKeys,
    anchor: { scrollRef, ...anchor },
    revealAll: find.open || Boolean(revealEventId) || jumpingToThisView,
  });

  useEffect(() => {
    if (!pendingJump || pendingJump.taskId !== ownerTaskId) return;
    if (!eventsReady) return;
    const jumpNonce = pendingJump.nonce;
    if (events.length === 0) {
      clearPendingJump(jumpNonce);
      return;
    }

    const targetId = pendingJump.eventId?.trim() || "";
    const searchQuery = pendingJump.query?.trim() || "";

    const fallbackAndClear = () => {
      if (targetId) {
        setRevealEventId((current) => (current === targetId ? null : current));
      }
      if (searchQuery) find.activate(searchQuery, { focus: false });
      clearPendingJump(jumpNonce);
    };

    if (!targetId) {
      fallbackAndClear();
      return;
    }

    const existsInRawEvents = events.some((event) => event.id === targetId);
    const existsInBlocks = isEventInTimelineBlocks(blocks, targetId);

    // 原始日志已有该事件，但被时间线抑制/隐藏而不会挂载到 DOM：直接回退查找并清理 pendingJump。
    if (existsInRawEvents && !existsInBlocks) {
      fallbackAndClear();
      return;
    }

    if (!existsInBlocks) {
      const paging = pagingRef.current;
      if (paging.nonce !== jumpNonce) {
        paging.nonce = jumpNonce;
        paging.loading = false;
        paging.attempts = 0;
        paging.exhausted = false;
        paging.lastEventsLen = -1;
      }
      if (!paging.loading && paging.lastEventsLen >= 0 && events.length <= paging.lastEventsLen) {
        paging.exhausted = true;
      }
      if (host.loadOlderHistory && !paging.exhausted && paging.attempts < 8) {
        if (!paging.loading) {
          paging.loading = true;
          paging.attempts += 1;
          paging.lastEventsLen = events.length;
          void host
            .loadOlderHistory(session.id)
            .then((exhausted) => {
              if (paging.nonce !== jumpNonce) return;
              paging.loading = false;
              if (exhausted) paging.exhausted = true;
              setPagingTick((tick) => tick + 1);
            })
            .catch(() => {
              if (paging.nonce !== jumpNonce) return;
              paging.loading = false;
              paging.exhausted = true;
              setPagingTick((tick) => tick + 1);
            });
        }
        return;
      }
      fallbackAndClear();
      return;
    }

    let expanding = false;
    const container = findTimelineContainerForEvent(blocks, targetId);
    if (container.turnId && foldOverrides.get(container.turnId) !== true) {
      expanding = true;
      setFoldOverrides((prev) => new Map(prev).set(container.turnId!, true));
    }
    if (container.liveId && liveOverrides.get(container.liveId) === false) {
      expanding = true;
      setLiveOverrides((prev) => new Map(prev).set(container.liveId!, true));
    }
    if (revealEventId !== targetId) {
      expanding = true;
      setRevealEventId(targetId);
    }
    if (expanding) return;

    const root = scrollRef.current;
    if (!root) return;
    const findTargetNode = (): HTMLElement | null => {
      for (const node of root.querySelectorAll<HTMLElement>("[data-find-event]")) {
        if (node.getAttribute("data-find-event") === targetId) return node;
      }
      return null;
    };
    const applyTargetJump = (targetNode: HTMLElement) => {
      targetNode.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
      holdScrollPosition();
      if (searchQuery) {
        find.activate(searchQuery, { focus: false, preferredEventId: targetId });
      }
      setHighlightedEventId(targetId);
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightedEventId((current) => (current === targetId ? null : current));
        setRevealEventId((current) => (current === targetId ? null : current));
        highlightTimerRef.current = null;
      }, 2200);
      clearPendingJump(jumpNonce);
    };

    const immediateNode = findTargetNode();
    if (immediateNode) {
      applyTargetJump(immediateNode);
      return;
    }

    let cancelled = false;
    let raf2: number | null = null;
    const raf1 = requestAnimationFrame(() => {
      if (cancelled) return;
      const node1 = findTargetNode();
      if (node1) {
        applyTargetJump(node1);
        return;
      }
      raf2 = requestAnimationFrame(() => {
        if (cancelled) return;
        const node2 = findTargetNode();
        if (node2) {
          applyTargetJump(node2);
          return;
        }
        fallbackAndClear();
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      if (raf2 !== null) cancelAnimationFrame(raf2);
    };
  }, [
    blocks,
    events,
    eventsReady,
    find.activate,
    foldOverrides,
    holdScrollPosition,
    host,
    liveOverrides,
    ownerTaskId,
    pagingTick,
    pendingJump,
    revealEventId,
    scrollRef,
    session.id,
  ]);

  const renderChunk = (chunk: (typeof chunks)[number]): ReactNode => {
    if (chunk.type === "events") {
      return (
        <ActivityStream
          events={chunk.events}
          session={effectiveSession}
          resolvedAnswers={resolvedAnswers}
          showAgentLabel={(event) => chunk.labels.get(event.id) ?? false}
          backgroundByToolCall={backgroundByToolCall}
          revealEventId={revealEventId}
          highlightedEventId={highlightedEventId}
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
          session={effectiveSession}
          resolvedAnswers={resolvedAnswers}
          expanded={expanded}
          backgroundByToolCall={backgroundByToolCall}
          revealEventId={revealEventId}
          highlightedEventId={highlightedEventId}
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
          starting={status === "starting"}
          session={effectiveSession}
          resolvedAnswers={resolvedAnswers}
          expanded={expanded}
          backgroundByToolCall={backgroundByToolCall}
          revealEventId={revealEventId}
          highlightedEventId={highlightedEventId}
          onInteract={pausePinForToggle}
          onToggle={() => {
            pausePinForToggle();
            setLiveOverrides((prev) => new Map(prev).set(block.id, !expanded));
          }}
        />
      );
    }
    const event = block.event;
    const highlighted = highlightedEventId === event.id;
    return (
      <div
        data-find-event={event.id}
        data-event-id={event.id}
        data-jump-highlighted={highlighted ? "true" : undefined}
        className={cn("min-w-0", highlighted && "rounded-xl ring-2 ring-wb-accent transition-shadow")}
      >
        <EventItem
          event={event}
          session={effectiveSession}
          resolvedAnswer={event.kind === "prompt" ? (resolvedAnswers.get(event.prompt_id) ?? null) : null}
          showAgentLabel={block.showAgentLabel}
        />
      </div>
    );
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
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
            <div className="px-6 py-4 text-sm text-wb-fg-3" data-history-pending role="status">正在加载对话…</div>
          ) : !hasVisibleEvent ? (
            <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-wb-border bg-wb-elev">
                <SessionAgentIcon identity={agentIdentity} className="h-5 w-5" />
              </div>
              <p className="text-sm font-medium text-wb-fg">{agentTurnName(session.agent, agentIdentity)}</p>
              <p className="text-xs text-wb-fg-3">
                {session.project_id ? "描述任务或问题，输入 @ 引用项目文件" : "输入任务或问题即可开始对话"}
              </p>
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
          {eventsReady && liveBlock?.type === "live" ? (
            <LiveStatus label={status === "starting" ? "正在启动" : liveActivityLabel(liveBlock.events)} startedAt={liveBlock.startedAt} />
          ) : null}
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
      {onCloseRewind && onRewindComplete ? (
        <RewindDialog
          target={rewindTarget}
          onCancel={onCloseRewind}
          onComplete={onRewindComplete}
        />
      ) : null}
      {pendingId && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-wb-warn/70 to-transparent" />
      )}
    </div>
  );
}
