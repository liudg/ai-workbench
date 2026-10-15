import { useMemo, useState } from "react";

import type { Session, SessionEvent } from "@/types";
import { ActivityGroup } from "../events/ActivityGroup";
import { foldActivity } from "../events/activity-fold";
import { EventItem } from "../events/EventItem";
import { ThinkingStatus } from "../events/ThinkingStatus";

/**
 * 一段会话过程。旁白按原顺序留下，相邻工具收成一行。
 * 思考正文不画。`thinking` 为真时，末行是进行中的「正在思考」。
 */
export function ActivityStream({
  events,
  session,
  resolvedAnswers,
  showAgentLabel,
  toolsOnly = false,
  thinking = false,
  onInteract,
}: {
  events: SessionEvent[];
  session: Session;
  resolvedAnswers: ReadonlyMap<string, string>;
  showAgentLabel: (event: SessionEvent) => boolean;
  toolsOnly?: boolean;
  thinking?: boolean;
  onInteract?: () => void;
}) {
  const pieces = useMemo(() => foldActivity(events), [events]);
  const visible = toolsOnly ? pieces.filter((piece) => piece.type === "tools") : pieces;
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());

  return (
    <div className="min-w-0" data-activity-stream>
      {visible.map((piece) => {
        if (piece.type === "tools") {
          return (
            <ActivityGroup
              key={piece.id}
              piece={piece}
              session={session}
              open={openGroups.has(piece.id)}
              onInteract={onInteract}
              onToggle={() => {
                onInteract?.();
                setOpenGroups((prev) => {
                  const next = new Set(prev);
                  if (next.has(piece.id)) next.delete(piece.id);
                  else next.add(piece.id);
                  return next;
                });
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
      {thinking && !toolsOnly ? <ThinkingStatus /> : null}
    </div>
  );
}
