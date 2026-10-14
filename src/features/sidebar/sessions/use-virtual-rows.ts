import { useLayoutEffect, useRef, useState } from "react";

import {
  clampRange,
  SESSION_ROW_OVERSCAN,
  visibleRange,
  type VirtualRange,
} from "./virtual-window";

function findScrollParent(node: HTMLElement): HTMLElement | null {
  let current = node.parentElement;
  while (current) {
    const overflow = getComputedStyle(current).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return current;
    current = current.parentElement;
  }
  return null;
}

export function useVirtualRows(count: number, itemHeight: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<VirtualRange>({ start: 0, end: Math.min(count, 24) });
  const displayed = clampRange(range, count);

  useLayoutEffect(() => {
    const list = ref.current;
    if (!list || count === 0) {
      setRange({ start: 0, end: 0 });
      return;
    }
    const scroller = findScrollParent(list);
    if (!scroller) {
      setRange({ start: 0, end: count });
      return;
    }
    let frame = 0;
    const update = () => {
      const listTop =
        list.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      const next = visibleRange({
        count,
        scrollTop: scroller.scrollTop - listTop,
        viewport: scroller.clientHeight,
        itemHeight,
        overscan: SESSION_ROW_OVERSCAN,
      });
      setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    observer?.observe(scroller);
    const content = scroller.firstElementChild;
    if (content) observer?.observe(content);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [count, itemHeight]);

  return { ref, start: displayed.start, end: displayed.end };
}
