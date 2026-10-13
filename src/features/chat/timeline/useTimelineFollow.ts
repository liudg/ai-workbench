import { useEffect, useLayoutEffect, useRef, type WheelEvent } from "react";

import { useWorkbench } from "@/store";

const NEAR_BOTTOM_PX = 80;

/** 时间线贴底、以及向上翻页时保持视口。分页走会话 store，不放在视图里。 */
export function useTimelineFollow(sessionId: string, layoutKey: string) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const pinningRef = useRef(false);
  const suppressPinRef = useRef(false);
  const interactingRef = useRef(false);
  const pointerStopRef = useRef<(() => void) | null>(null);
  const seenSession = useRef(sessionId);
  const historyExhausted = useRef(false);
  const historyLoading = useRef(false);
  const loadOlderHistory = useWorkbench((s) => s.loadOlderHistory);
  const pagedHistory = useWorkbench(
    (s) => s.catalogs[sessionId]?.capabilities.supports_paged_history === true,
  );

  const pinRef = useRef(() => {});
  pinRef.current = () => {
    if (suppressPinRef.current || interactingRef.current || !followRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const top = Math.max(0, el.scrollHeight - el.clientHeight);
    if (el.scrollTop >= top - 1) return;
    pinningRef.current = true;
    el.scrollTop = top;
    requestAnimationFrame(() => {
      pinningRef.current = false;
    });
  };

  useEffect(() => {
    historyExhausted.current = false;
    historyLoading.current = false;
  }, [sessionId]);

  useLayoutEffect(() => {
    if (seenSession.current !== sessionId) {
      seenSession.current = sessionId;
      followRef.current = true;
    }
    pinRef.current();
  }, [sessionId, layoutKey]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => pinRef.current());
    observer.observe(content);
    return () => observer.disconnect();
  }, [sessionId]);

  useEffect(() => {
    return () => {
      const stop = pointerStopRef.current;
      if (!stop) return;
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  const requestOlder = () => {
    if (!pagedHistory || historyExhausted.current || historyLoading.current) return;
    const el = scrollRef.current;
    if (!el) return;
    historyLoading.current = true;
    const before = el.scrollHeight;
    const top = el.scrollTop;
    suppressPinRef.current = true;
    followRef.current = false;
    void loadOlderHistory(sessionId)
      .then((exhausted) => {
        if (exhausted) historyExhausted.current = true;
        requestAnimationFrame(() => {
          const node = scrollRef.current;
          if (node) node.scrollTop = top + Math.max(0, node.scrollHeight - before);
          requestAnimationFrame(() => {
            suppressPinRef.current = false;
            historyLoading.current = false;
          });
        });
      })
      .catch(() => {
        suppressPinRef.current = false;
        historyLoading.current = false;
      });
  };

  const onTimelineScroll = () => {
    const el = scrollRef.current;
    if (!el || pinningRef.current) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (el.scrollTop < 48) requestOlder();
  };

  const onTimelineWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY >= 0) return;
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop < 48) requestOlder();
    const pixels =
      event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * el.clientHeight
          : event.deltaY;
    const nextTop = Math.max(0, el.scrollTop + pixels);
    const nextDistance = el.scrollHeight - nextTop - el.clientHeight;
    if (nextDistance >= NEAR_BOTTOM_PX) followRef.current = false;
  };

  const onPointerDown = () => {
    interactingRef.current = true;
    if (pointerStopRef.current) return;
    const stop = () => {
      interactingRef.current = false;
      pointerStopRef.current = null;
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    pointerStopRef.current = stop;
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const pausePinForToggle = () => {
    suppressPinRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        suppressPinRef.current = false;
      });
    });
  };

  return {
    scrollRef,
    contentRef,
    onTimelineScroll,
    onTimelineWheel,
    onPointerDown,
    pausePinForToggle,
  };
}
