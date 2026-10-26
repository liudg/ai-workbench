import { useEffect, useLayoutEffect, useRef, type WheelEvent } from "react";

import { useChatHost } from "../host";
import {
  compensatedScrollTop,
  distanceFromBottom,
  historyScrollTop,
  nearBottom,
  shouldApplyHistory,
  type TimelineAnchor,
} from "./timeline-follow";

/** 时间线贴底、以及向上翻页时保持视口。分页走会话 store，不放在视图里。 */
export function useTimelineFollow(sessionId: string, layoutKey: string): TimelineAnchor & {
  contentRef: { current: HTMLDivElement | null };
  onTimelineScroll: () => void;
  onTimelineWheel: (event: WheelEvent<HTMLDivElement>) => void;
  onPointerDown: () => void;
  pausePinForToggle: () => void;
} {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const distanceRef = useRef(0);
  const anchorTopRef = useRef(0);
  const pinningRef = useRef(false);
  const suppressPinRef = useRef(false);
  const interactingRef = useRef(false);
  const pointerStopRef = useRef<(() => void) | null>(null);
  const seenSession = useRef(sessionId);
  const historyExhausted = useRef(false);
  const historyLoading = useRef(false);
  const requestEpoch = useRef(0);
  const loadOlderHistory = useChatHost().loadOlderHistory;

  if (seenSession.current !== sessionId) {
    seenSession.current = sessionId;
    followRef.current = true;
    distanceRef.current = 0;
    anchorTopRef.current = 0;
    suppressPinRef.current = false;
    interactingRef.current = false;
    historyExhausted.current = false;
    historyLoading.current = false;
    requestEpoch.current += 1;
  }

  const applyScrollRef = useRef<(aboveDelta: number) => void>(() => {});
  applyScrollRef.current = (aboveDelta: number) => {
    const el = scrollRef.current;
    if (!el || interactingRef.current) return;
    const follow = followRef.current && !suppressPinRef.current;
    const top = compensatedScrollTop({
      beforeTop: anchorTopRef.current,
      nextHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      follow,
      aboveDelta,
    });
    if (top == null) return;
    if (Math.abs(el.scrollTop - top) <= 1) {
      anchorTopRef.current = el.scrollTop;
      if (follow) distanceRef.current = 0;
      return;
    }
    pinningRef.current = true;
    el.scrollTop = top;
    anchorTopRef.current = el.scrollTop;
    if (follow) distanceRef.current = 0;
    requestAnimationFrame(() => {
      pinningRef.current = false;
    });
  };
  const applyScroll = (aboveDelta: number) => applyScrollRef.current(aboveDelta);

  useEffect(() => {
    return () => {
      requestEpoch.current += 1;
    };
  }, []);

  useLayoutEffect(() => {
    applyScrollRef.current(0);
  }, [sessionId, layoutKey]);

  useEffect(() => {
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if ((!content && !scroller) || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => applyScrollRef.current(0));
    if (content) observer.observe(content);
    if (scroller) observer.observe(scroller);
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
    if (!loadOlderHistory || historyExhausted.current || historyLoading.current) return;
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
            const top = historyScrollTop({
              beforeHeight,
              beforeTop,
              nextHeight: node.scrollHeight,
            });
            pinningRef.current = true;
            node.scrollTop = top;
            anchorTopRef.current = node.scrollTop;
            distanceRef.current = distanceFromBottom(node.scrollHeight, node.scrollTop, node.clientHeight);
            followRef.current = nearBottom(distanceRef.current);
          }
          requestAnimationFrame(() => {
            if (!shouldApplyHistory({ epoch, currentEpoch: requestEpoch.current })) return;
            pinningRef.current = false;
            suppressPinRef.current = false;
            historyLoading.current = false;
          });
        });
      })
      .catch(() => {
        if (!shouldApplyHistory({ epoch, currentEpoch: requestEpoch.current })) return;
        const node = scrollRef.current;
        if (node) {
          anchorTopRef.current = node.scrollTop;
          distanceRef.current = distanceFromBottom(node.scrollHeight, node.scrollTop, node.clientHeight);
          followRef.current = nearBottom(distanceRef.current);
        }
        suppressPinRef.current = false;
        historyLoading.current = false;
      });
  };

  const onTimelineScroll = () => {
    const el = scrollRef.current;
    if (!el || pinningRef.current) return;
    anchorTopRef.current = el.scrollTop;
    distanceRef.current = distanceFromBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
    followRef.current = nearBottom(distanceRef.current);
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
        applyScrollRef.current(0);
      });
    });
  };

  return {
    scrollRef,
    contentRef,
    followRef,
    distanceRef,
    anchorTopRef,
    pinningRef,
    applyScroll,
    onTimelineScroll,
    onTimelineWheel,
    onPointerDown,
    pausePinForToggle,
  };
}
