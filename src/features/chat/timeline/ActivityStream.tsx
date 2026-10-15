import { useMemo, useState } from "react";

import type { Session, SessionEvent } from "@/types";
import { ActivityGroup } from "../events/ActivityGroup";
import { foldActivity } from "../events/activity-fold";
import { EventItem } from "../events/EventItem";
import { ThinkingFold } from "../events/ThinkingFold";

/**
 * 一段会话过程。旁白按原顺序留下，相邻工具收成一行，思考最多一条且默认收起。
 * `toolsOnly` 仍按完整顺序分组，只是先不画出旁白和思考。
 */
export function ActivityStream({
  events,
  session,
  resolvedAnswers,
  showAgentLabel,
  toolsOnly = false,
  onInteract,
}: {
  events: SessionEvent[];
  session: Session;
  resolvedAnswers: ReadonlyMap<string, string>;
  showAgentLabel: (event: SessionEvent) => boolean;
  toolsOnly?: boolean;
  onInteract?: () => void;
}) {
  const pieces = useMemo(() => foldActivity(events), [events]);
  const visible = toolsOnly ? pieces.filter((piece) => piece.type === "tools") : pieces;
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());

  return (
    <div className="min-w-0" data-activity-stream>
      {visible.map((piece) => {
        if (piece.type === "thinking") {
          return (
            <ThinkingFold
              key={piece.id}
              text={piece.text}
              open={thinkingOpen}
              onToggle={() => {
                onInteract?.();
                setThinkingOpen((value) => !value);
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
    </div>
  );
}
