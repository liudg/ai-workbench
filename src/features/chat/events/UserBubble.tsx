import { MessageSquare } from "lucide-react";

import { cn } from "@/lib/utils";

import { MessageContent } from "../answer/MessageContent";
import { annotationCountLabel, annotationCountOf } from "./annotation-count";
import { CopyButton, HoverActions } from "./chrome";
import { EventImages } from "./EventImages";
import type { EventViewProps } from "./types";
import { userBubbleModel } from "./user-image-layout";

export function UserBubble({ event, time }: EventViewProps) {
  if (event.kind !== "user-message") return null;
  const text = event.text;
  const images = event.images ?? [];
  const badge = annotationCountOf(event.annotations);
  const model = userBubbleModel(text, images.length);
  return (
    <div className="event-in group min-w-0 px-6 py-2">
      <div className="flex min-w-0 justify-end">
        <div
          className={cn(
            "flex min-w-0 max-w-[85%] flex-col items-end gap-2",
            model.images && "w-full",
          )}
        >
          {model.images ? (
            <div
              data-user-image-layer
              data-image-count={images.length}
              data-image-columns={model.images.columns}
              className={model.images.frameClassName}
            >
              <EventImages paths={images} className={model.images.thumbClassName} />
            </div>
          ) : null}
          {model.showTextBubble ? (
            <div data-user-text className={model.textBubbleClass}>
              {text ? <MessageContent text={text} /> : null}
            </div>
          ) : null}
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
