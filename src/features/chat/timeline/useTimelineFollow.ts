import { useEffect, useLayoutEffect, useRef, type WheelEvent } from "react";

import { useWorkbench } from "@/store";
import { distanceFromBottom, historyScrollTop, nearBottom, shouldApplyHistory } from "./timeline-follow";

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
  const requestEpoch = useRef(0);
  const loadOlderHistory = useWorkbench((s) => s.loadOlderHistory);
  const pagedHistory = useWorkbench(
    (s) => s.catalogs[sessionId]?.capabilities.supports_paged_history === true,
  );

  if (seenSession.current !== sessionId) {
    seenSession.current = sessionId;
    followRef.current = true;
    suppressPinRef.current = false;
    interactingRef.current = false;
    historyExhausted.current = false;
    historyLoading.current = false;
    requestEpoch.current += 1;
  }

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
    return () => {
      requestEpoch.current += 1;
    };
  }, []);

  useLayoutEffect(() => {
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
    const epoch = requestEpoch.current;
    historyLoading.current = true;
    const beforeHeight = el.scrollHeight;
    const beforeTop = el.scrollTop;
    suppressPinRef.current = true;
    followRef.current = false;
    void loadOlderHistory(sessionId)
      .then((exhausted) => {
        if (!shouldApplyHistory({ epoch, currentEpoch: requestEpoch.current })) return;
        if (exhausted) historyExhausted.current = true;
        requestAnimationFrame(() => {
          if (!shouldApplyHistory({ epoch, currentEpoch: requestEpoch.current })) return;
          const node = scrollRef.current;
          if (node) {
            node.scrollTop = historyScrollTop({
              beforeHeight,
              beforeTop,
              nextHeight: node.scrollHeight,
            });
            followRef.current = nearBottom(
              distanceFromBottom(node.scrollHeight, node.scrollTop, node.clientHeight),
            );
          }
          requestAnimationFrame(() => {
            if (!shouldApplyHistory({ epoch, currentEpoch: requestEpoch.current })) return;
            suppressPinRef.current = false;
            historyLoading.current = false;
          });
        });
      })
      .catch(() => {
        if (!shouldApplyHistory({ epoch, currentEpoch: requestEpoch.current })) return;
        const node = scrollRef.current;
        if (node) {
          followRef.current = nearBottom(
            distanceFromBottom(node.scrollHeight, node.scrollTop, node.clientHeight),
          );
        }
        suppressPinRef.current = false;
        historyLoading.current = false;
      });
  };

  const onTimelineScroll = () => {
    const el = scrollRef.current;
    if (!el || pinningRef.current) return;
    followRef.current = nearBottom(distanceFromBottom(el.scrollHeight, el.scrollTop, el.clientHeight));
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
    const nextDistance = distanceFromBottom(el.scrollHeight, nextTop, el.clientHeight);
    if (!nearBottom(nextDistance)) followRef.current = false;
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
