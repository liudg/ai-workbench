import { ChevronRight, Image as ImageIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { viewedImagesLabel, type ActivityPiece } from "./activity-fold";
import { EventImages } from "./EventImages";

type ImagePiece = Extract<ActivityPiece, { type: "images" }>;

/**
 * 一次查看图像。收起只留「已查看 N 张图像」，展开后是横向缩略图。
 */
export function ViewedImages({
  piece,
  open,
  onToggle,
}: {
  piece: ImagePiece;
  open: boolean;
  onToggle: () => void;
}) {
  const label = viewedImagesLabel(piece.count);
  const canOpen = piece.paths.length > 0;
  const expanded = canOpen && open;

  return (
    <div
      className="event-in min-w-0 px-6 py-1"
      data-viewed-images
      data-viewed-count={piece.count}
      data-viewed-summary={label}
    >
      <div className="min-w-0 pl-6">
        <button
          type="button"
          data-viewed-toggle
          data-expanded={expanded ? "true" : "false"}
          aria-expanded={canOpen ? expanded : undefined}
          onClick={() => {
            if (canOpen) onToggle();
          }}
          className="inline-flex max-w-full min-w-0 items-center gap-2 py-0.5 text-left text-[13px] text-[var(--wb-text-secondary)] transition-colors hover:text-[var(--wb-text-strong)]"
        >
          <ImageIcon className="h-3.5 w-3.5 shrink-0 text-[var(--wb-muted)]" />
          <span className="min-w-0 truncate">{label}</span>
          {canOpen ? (
            <ChevronRight
              className={cn("h-3.5 w-3.5 shrink-0 text-[var(--wb-faint)] transition-transform", expanded && "rotate-90")}
            />
          ) : null}
        </button>
        {expanded ? (
          <div data-viewed-thumbs className="mt-1.5 flex min-w-0 gap-2 overflow-x-auto pl-[22px] pb-0.5">
            <EventImages
              paths={piece.paths}
              className="h-[76px] w-[76px] shrink-0 rounded-[10px] object-cover"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
