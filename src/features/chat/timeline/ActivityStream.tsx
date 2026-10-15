import { useMemo, useState } from "react";

import type { Session, SessionEvent } from "@/types";
import { ActivityGroup } from "../events/ActivityGroup";
import { foldActivity } from "../events/activity-fold";
import { activityOpenAfterSettle, toggleToolGroup, toolGroupOpen } from "../events/activity-open";
import { EventItem } from "../events/EventItem";
import { ThinkingStatus } from "../events/ThinkingStatus";
import { ViewedImages } from "../events/ViewedImages";

/**
 * 一段会话过程。旁白按原顺序留下，相邻工具收成一行，查看图像单独成行。
 * 思考正文不画。`thinking` 为真时，末行是进行中的「正在思考」。
 * `settled` 为真时，进行中点开过的工具行收回去，默认只留一行摘要。
 */
export function ActivityStream({
  events,
  session,
  resolvedAnswers,
  showAgentLabel,
  thinking = false,
  settled = false,
  onInteract,
}: {
  events: SessionEvent[];
  session: Session;
  resolvedAnswers: ReadonlyMap<string, string>;
  showAgentLabel: (event: SessionEvent) => boolean;
  thinking?: boolean;
  settled?: boolean;
  onInteract?: () => void;
}) {
  const pieces = useMemo(() => foldActivity(events), [events]);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [seenSettled, setSeenSettled] = useState(settled);
  if (settled !== seenSettled) {
    setSeenSettled(settled);
    const next = activityOpenAfterSettle(openGroups, seenSettled, settled);
    if (next !== openGroups) setOpenGroups(next);
  }

  return (
    <div className="min-w-0" data-activity-stream data-activity-settled={settled ? "true" : "false"}>
      {pieces.map((piece) => {
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
              onToggle={() => {
                onInteract?.();
                setOpenGroups((prev) => toggleToolGroup(prev, piece.id));
              }}
            />
          );
        }
        const event = piece.event;
        return (
          <EventItem
            key={event.id}
            event={event}
            session={session}
            resolvedAnswer={
              event.kind === "prompt" ? (resolvedAnswers.get(event.prompt_id) ?? null) : null
            }
            showAgentLabel={showAgentLabel(event)}
          />
        );
      })}
      {thinking ? <ThinkingStatus /> : null}
    </div>
  );
}
