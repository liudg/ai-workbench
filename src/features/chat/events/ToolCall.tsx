import { EventImages } from "./EventImages";
import { hasGeneratedImages } from "./generated-images";
import type { EventViewProps } from "./types";

/**
 * 时间线里单独画出来的工具调用只有生成的图片。
 * 其它工具调用都由活动流收进摘要行（`ActivityGroup`），在那里点开看命令和输出。
 */
export function ToolCall({ event }: EventViewProps) {
  if (event.kind !== "tool-call" || !hasGeneratedImages(event)) return null;
  return (
    <div className="event-in min-w-0 px-6 py-3 pl-12" data-generated-images>
      <EventImages
        paths={event.images ?? []}
        className="block max-h-[240px] w-auto max-w-[min(100%,280px)] rounded-xl object-contain"
        frameClassName="flex min-w-0 flex-wrap items-start gap-3"
      />
    </div>
  );
}
