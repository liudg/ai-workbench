import { MessageSquare } from "lucide-react";

import { MessageContent } from "../answer/MessageContent";
import { annotationCountLabel, annotationCountOf } from "./annotation-count";
import { CopyButton, HoverActions } from "./chrome";
import { EventImages } from "./EventImages";
import type { EventViewProps } from "./types";

export function UserBubble({ event, time }: EventViewProps) {
  if (event.kind !== "user-message") return null;
  const text = event.text;
  const images = event.images ?? [];
  const badge = annotationCountOf(event.annotations);
  const annotationOnly = badge !== null && !text.trim();
  return (
    <div className="event-in group min-w-0 px-6 py-2">
      <div className="mx-auto flex min-w-0 max-w-3xl justify-end">
        <div className="flex min-w-0 max-w-[85%] flex-col items-end gap-2">
          {annotationOnly ? (
            <EventImages paths={images} className="max-h-28 max-w-[140px] rounded-lg object-cover" />
          ) : (
            <div className="min-w-0 max-w-full cursor-text overflow-x-hidden rounded-2xl rounded-br-sm bg-indigo-600/90 px-4 py-2.5 text-sm leading-6 text-white">
              <EventImages
                paths={images}
                className="max-h-40 max-w-[160px] rounded-lg object-contain"
                frameClassName="mb-1 flex min-w-0 flex-wrap gap-1.5 overflow-x-hidden"
              />
              {text ? <MessageContent text={text} /> : null}
            </div>
          )}
          {badge ? (
            <span
              data-annotation-count={badge.count}
              className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700"
            >
              <MessageSquare className="h-3 w-3" />
              {annotationCountLabel(badge.count)}
            </span>
          ) : null}
          <HoverActions time={time}>{text ? <CopyButton text={text} /> : null}</HoverActions>
        </div>
      </div>
    </div>
  );
}
