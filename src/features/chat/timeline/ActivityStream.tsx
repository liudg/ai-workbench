import { useMemo, useState } from "react";

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
  onInteract,
}: {
  events: SessionEvent[];
  session: Session;
  resolvedAnswers: ReadonlyMap<string, string>;
  showAgentLabel: (event: SessionEvent) => boolean;
  live?: boolean;
  settled?: boolean;
  backgroundByToolCall?: ReadonlyMap<string, BackgroundTaskEvent>;
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

  return (
    <div className="min-w-0" data-activity-stream data-activity-settled={settled ? "true" : "false"}>
      {pieces.map((piece, index) => {
        if (piece.type === "images") {
          return (
            <ViewedImages
              key={piece.id}
              piece={piece}
              open={toolGroupOpen(openGroups, piece.id)}
              onToggle={() => {
                onInteract?.();
                setOpenGroups((prev) => toggleToolGroup(prev, piece.id));
              }}
            />
          );
        }
        if (piece.type === "tools") {
          return (
            <ActivityGroup
              key={piece.id}
              piece={piece}
              session={session}
              open={toolGroupOpen(openGroups, piece.id)}
              live={live}
              backgroundByToolCall={localBackgrounds}
              onToggle={() => {
                onInteract?.();
                setOpenGroups((prev) => toggleToolGroup(prev, piece.id));
              }}
            />
          );
        }
        const event = piece.event;
        const labeled = showAgentLabel(event);
        return (
          <EventItem
            key={event.id}
            event={event}
            session={session}
            resolvedAnswer={
              event.kind === "prompt" ? (resolvedAnswers.get(event.prompt_id) ?? null) : null
            }
            showAgentLabel={labeled}
            showMessageFooter={labeled && !laterTools(pieces, index)}
            thinkingOpen={
              event.kind === "thinking"
                ? thinkingBlockOpen(thinkingOverrides, event.id, liveThinking)
                : false
            }
            onToggleThinking={() => {
              onInteract?.();
              setThinkingOverrides((prev) => toggleThinkingBlock(prev, event.id, liveThinking));
            }}
          />
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
