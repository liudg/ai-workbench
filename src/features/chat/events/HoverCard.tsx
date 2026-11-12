import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const OPEN_DELAY_MS = 250;
const CARD_WIDTH = 320;

/**
 * 悬停一会儿在行下面出一张卡片。行在会裁切的容器里，卡片挂到 body 上按行的位置摆。
 * 照 t3code `SubagentTooltipContent.tsx` 的悬停卡片。
 */
export function HoverCard({ content, children }: { content: ReactNode; children: ReactNode }) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number; above: boolean } | null>(null);

  const clear = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  const show = () => {
    clear();
    timer.current = window.setTimeout(() => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const left = Math.max(8, Math.min(rect.left + 24, window.innerWidth - CARD_WIDTH - 8));
      const above = rect.bottom + 180 > window.innerHeight;
      setPlace({ left, top: above ? rect.top - 4 : rect.bottom + 4, above });
    }, OPEN_DELAY_MS);
  };
  const hide = () => {
    clear();
    setPlace(null);
  };

  return (
    <div ref={anchorRef} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} className="min-w-0">
      {children}
      {place && content
        ? createPortal(
            <div
              role="tooltip"
              data-hover-card
              className="wb-popover pointer-events-none fixed z-50 px-3 py-2.5 text-xs leading-5 text-wb-fg-2"
              style={{
                left: place.left,
                width: CARD_WIDTH,
                ...(place.above ? { bottom: window.innerHeight - place.top } : { top: place.top }),
              }}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
