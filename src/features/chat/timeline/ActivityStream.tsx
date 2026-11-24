import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import type { Session, SessionEvent } from "@/types";
import { ActivityGroup } from "../events/ActivityGroup";
import { foldActivity, type ActivityPiece } from "../events/activity-fold";
import {
  backgroundTasksByToolCall,
  type BackgroundTaskEvent,
} from "../events/background-task-display";
import {
  activeThinkingId,
  activityOpenAfterSettle,
  thinkingBlockOpen,
  thinkingOverridesAfterSettle,
  toggleThinkingBlock,
  toggleToolGroup,
  toolGroupOpen,
} from "../events/activity-open";
import { EventItem } from "../events/EventItem";
import { useSessionProjectPath } from "../events/use-session-project-path";
import { ViewedImages } from "../events/ViewedImages";

/**
 * 一段会话的事件，按发生顺序画。相邻工具收成一行，查看图像单独成行。
 * 进行中的最后一条思考默认展开，进入下一步工具或回合结束后自动收成一行摘要。
 * 进行中的末行由 `ChatView` 显示。
 * `live` 为真时，适配器报的进行中工具才转圈。
 * `settled` 为真时，进行中点开过的工具行和思考全部收回去，默认只留一行摘要。
 */
export function ActivityStream({
  events,
  session,
  resolvedAnswers,
  showAgentLabel,
  live = false,
  settled = false,
  backgroundByToolCall,
  revealEventId,
  highlightedEventId,
  onInteract,
}: {
  events: SessionEvent[];
  session: Session;
  resolvedAnswers: ReadonlyMap<string, string>;
  showAgentLabel: (event: SessionEvent) => boolean;
  live?: boolean;
  settled?: boolean;
  backgroundByToolCall?: ReadonlyMap<string, BackgroundTaskEvent>;
  revealEventId?: string | null;
  highlightedEventId?: string | null;
  onInteract?: () => void;
}) {
  const projectPath = useSessionProjectPath(session);
  const localBackgrounds = useMemo(
    () => backgroundByToolCall ?? backgroundTasksByToolCall(events),
    [backgroundByToolCall, events],
  );
  const pieces = useMemo(() => foldActivity(events, projectPath), [events, projectPath]);
  const liveThinking = useMemo(
    () => activeThinkingId(events, live, settled),
    [events, live, settled],
  );
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [thinkingOverrides, setThinkingOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const [seenSettled, setSeenSettled] = useState(settled);
  if (settled !== seenSettled) {
    setSeenSettled(settled);
    const nextGroups = activityOpenAfterSettle(openGroups, seenSettled, settled);
    if (nextGroups !== openGroups) setOpenGroups(nextGroups);
    const nextThinking = thinkingOverridesAfterSettle(thinkingOverrides, seenSettled, settled);
    if (nextThinking !== thinkingOverrides) setThinkingOverrides(nextThinking);
  }

  useEffect(() => {
    if (!revealEventId) return;
    for (const piece of pieces) {
      if (piece.type === "tools" && piece.steps.some((step) => step.event.id === revealEventId)) {
        setOpenGroups((prev) => (prev.has(piece.id) ? prev : new Set(prev).add(piece.id)));
      } else if (piece.type === "images" && piece.id === revealEventId) {
        setOpenGroups((prev) => (prev.has(piece.id) ? prev : new Set(prev).add(piece.id)));
      } else if (
        piece.type === "event" &&
        piece.event.kind === "thinking" &&
        piece.event.id === revealEventId
      ) {
        setThinkingOverrides((prev) => (prev.get(piece.event.id) === true ? prev : new Map(prev).set(piece.event.id, true)));
      }
    }
  }, [pieces, revealEventId]);

  return (
    <div className="min-w-0" data-activity-stream data-activity-settled={settled ? "true" : "false"}>
      {pieces.map((piece, index) => {
        if (piece.type === "images") {
          const highlighted = highlightedEventId === piece.id;
          return (
            <div
              key={piece.id}
              data-find-event={piece.id}
              data-event-id={piece.id}
              data-jump-highlighted={highlighted ? "true" : undefined}
              className={cn("min-w-0", highlighted && "rounded-xl ring-2 ring-wb-accent transition-shadow")}
            >
              <ViewedImages
                piece={piece}
                open={toolGroupOpen(openGroups, piece.id) || revealEventId === piece.id}
                onToggle={() => {
                  onInteract?.();
                  setOpenGroups((prev) => toggleToolGroup(prev, piece.id));
                }}
              />
            </div>
          );
        }
        if (piece.type === "tools") {
          const matchedId =
            (highlightedEventId && piece.steps.find((s) => s.event.id === highlightedEventId)?.event.id) ||
            (revealEventId && piece.steps.find((s) => s.event.id === revealEventId)?.event.id) ||
            piece.id;
          const highlighted = Boolean(
            highlightedEventId && piece.steps.some((step) => step.event.id === highlightedEventId),
          );
          const forceOpen = Boolean(
            revealEventId && piece.steps.some((step) => step.event.id === revealEventId),
          );
          return (
            <div
              key={piece.id}
              data-find-event={matchedId}
              data-event-id={matchedId}
              data-jump-highlighted={highlighted ? "true" : undefined}
              className={cn("min-w-0", highlighted && "rounded-xl ring-2 ring-wb-accent transition-shadow")}
            >
              <ActivityGroup
                piece={piece}
                session={session}
                open={toolGroupOpen(openGroups, piece.id) || forceOpen}
                live={live}
                backgroundByToolCall={localBackgrounds}
                revealEventId={revealEventId}
                onToggle={() => {
                  onInteract?.();
                  setOpenGroups((prev) => toggleToolGroup(prev, piece.id));
                }}
              />
            </div>
          );
        }
        const event = piece.event;
        const labeled = showAgentLabel(event);
        const highlighted = highlightedEventId === event.id;
        return (
          <div
            key={event.id}
            data-find-event={event.id}
            data-event-id={event.id}
            data-jump-highlighted={highlighted ? "true" : undefined}
            className={cn("min-w-0", highlighted && "rounded-xl ring-2 ring-wb-accent transition-shadow")}
          >
            <EventItem
              event={event}
              session={session}
              resolvedAnswer={
                event.kind === "prompt" ? (resolvedAnswers.get(event.prompt_id) ?? null) : null
              }
              showAgentLabel={labeled}
              showMessageFooter={labeled && !laterTools(pieces, index)}
              thinkingOpen={
                event.kind === "thinking"
                  ? event.id === revealEventId || thinkingBlockOpen(thinkingOverrides, event.id, liveThinking)
                  : false
              }
              onToggleThinking={() => {
                onInteract?.();
                setThinkingOverrides((prev) => toggleThinkingBlock(prev, event.id, liveThinking));
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

/** 时间不要夹在这段正文和后面的工具摘要之间。 */
function laterTools(pieces: readonly ActivityPiece[], index: number): boolean {
  for (let cursor = index + 1; cursor < pieces.length; cursor += 1) {
    const kind = pieces[cursor].type;
    if (kind === "tools" || kind === "images") return true;
  }
  return false;
}
