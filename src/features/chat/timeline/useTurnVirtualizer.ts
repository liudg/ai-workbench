import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { distanceFromBottom, nearBottom, type TimelineAnchor } from "./timeline-follow";
import {
  aboveViewportDelta,
  distanceAfterHeightChange,
  turnHeights,
  turnWindow,
  TURN_VIEWPORT_FALLBACK,
  type TurnMeasure,
} from "./turn-virtualizer";

/**
 * 只挂贴底窗口里的回合，并用测量高度把滚动补回原来的距底位置。
 * 列表外壳的高度是全部回合之和，未挂上的部分留在这层空隙里。
 */
export function useTurnVirtualizer(input: {
  sessionId: string;
  keys: readonly string[];
  anchor: TimelineAnchor;
  revealAll: boolean;
}) {
  const { sessionId, keys, anchor, revealAll } = input;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const measuredRef = useRef(new Map<string, number>());
  const nodesRef = useRef(new Map<string, HTMLDivElement>());
  const keyByNodeRef = useRef(new WeakMap<HTMLElement, string>());
  const refCallbacks = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
  const laidOutRef = useRef<{ keys: string[]; heights: number[] }>({ keys: [], heights: [] });
  const keysRef = useRef(keys);
  const seenSession = useRef(sessionId);
  const [viewport, setViewport] = useState(TURN_VIEWPORT_FALLBACK);
  const [, setEpoch] = useState(0);

  if (seenSession.current !== sessionId) {
    seenSession.current = sessionId;
    measuredRef.current.clear();
    nodesRef.current.clear();
    refCallbacks.current.clear();
    laidOutRef.current = { keys: [], heights: [] };
  }
  keysRef.current = keys;

  const heights = turnHeights(keys, measuredRef.current);
  const laidOut = laidOutRef.current;
  const above = aboveViewportDelta({
    before: measuresOf(laidOut.keys, laidOut.heights),
    after: measuresOf(keys, heights),
    scrollTop: anchor.anchorTopRef.current,
  });
  const beforeTotal = totalOf(laidOut.heights);
  const afterTotal = totalOf(heights);
  const distance = anchor.followRef.current
    ? 0
    : beforeTotal > 0
      ? anchor.distanceRef.current + (afterTotal - beforeTotal - above)
      : anchor.distanceRef.current;
  const liveViewport = anchor.scrollRef.current?.clientHeight ?? 0;
  const resolvedViewport = liveViewport > 0 ? liveViewport : viewport;
  const span = turnWindow({
    count: keys.length,
    distanceFromBottom: distance,
    viewport: revealAll ? Math.max(resolvedViewport, afterTotal, 1) : resolvedViewport,
    heights,
  });
  const start = revealAll ? 0 : span.start;
  const end = revealAll ? keys.length : span.end;
  const renderedRef = useRef({ start, end });
  renderedRef.current = { start, end };
  const heightKey = heights.join(",");
  const keyKey = keys.join("\0");

  useLayoutEffect(() => {
    const current = anchorRef.current;
    const el = current.scrollRef.current;
    const nextViewport = el?.clientHeight ?? 0;
    if (nextViewport > 0) setViewport((prev) => (prev === nextViewport ? prev : nextViewport));
    const pendingAbove = aboveViewportDelta({
      before: measuresOf(laidOutRef.current.keys, laidOutRef.current.heights),
      after: measuresOf(keys, heights),
      scrollTop: current.anchorTopRef.current,
    });
    current.applyScroll(current.followRef.current ? 0 : pendingAbove);
    current.distanceRef.current = distanceAfterHeightChange({
      beforeDistance: current.distanceRef.current,
      beforeTotal: totalOf(laidOutRef.current.heights),
      afterTotal: totalOf(heights),
      aboveDelta: pendingAbove,
      follow: current.followRef.current,
    });
    laidOutRef.current = { keys: keys.slice(), heights: heights.slice() };

    let changed = false;
    for (let index = start; index < end; index += 1) {
      const key = keys[index];
      if (!key) continue;
      const node = nodesRef.current.get(key);
      if (!node) continue;
      const next = node.offsetHeight;
      if (next > 0 && measuredRef.current.get(key) !== next) {
        measuredRef.current.set(key, next);
        changed = true;
      }
    }
    if (changed) setEpoch((value) => value + 1);
    // 高度差在效果里按 laidOutRef 重算。严格模式再跑一次时差值已是 0，不会补两次。
    // heights / keys 用 heightKey、keyKey 代表，避免每次渲染的新数组把滚动再补一次。
  }, [end, heightKey, keyKey, sessionId, start]);

  useEffect(() => {
    const el = anchorRef.current.scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const current = anchorRef.current;
      if (current.pinningRef.current) return;
      const nextDistance = distanceFromBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
      current.distanceRef.current = nextDistance;
      current.anchorTopRef.current = el.scrollTop;
      current.followRef.current = nearBottom(nextDistance);
      const next = turnWindow({
        count: keysRef.current.length,
        distanceFromBottom: current.followRef.current ? 0 : nextDistance,
        viewport: el.clientHeight || TURN_VIEWPORT_FALLBACK,
        heights: turnHeights(keysRef.current, measuredRef.current),
      });
      const prev = renderedRef.current;
      if (prev.start === next.start && prev.end === next.end) return;
      setEpoch((value) => value + 1);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [sessionId]);

  useEffect(() => {
    if (typeof ResizeObserver !== "function") return;
    const el = anchorRef.current.scrollRef.current;
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        if (el && node === el) {
          const next = el.clientHeight;
          if (next > 0) setViewport((prev) => (prev === next ? prev : next));
          continue;
        }
        const key = keyByNodeRef.current.get(node);
        if (!key) continue;
        const next = node.offsetHeight;
        if (next > 0 && measuredRef.current.get(key) !== next) {
          measuredRef.current.set(key, next);
          changed = true;
        }
      }
      if (changed) setEpoch((value) => value + 1);
    });
    if (el) observer.observe(el);
    for (const node of nodesRef.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [end, keyKey, sessionId, start]);

  const refFor = (key: string) => {
    let callback = refCallbacks.current.get(key);
    if (!callback) {
      callback = (node: HTMLDivElement | null) => {
        const prev = nodesRef.current.get(key) ?? null;
        if (prev === node) return;
        if (prev) nodesRef.current.delete(key);
        if (node) {
          nodesRef.current.set(key, node);
          keyByNodeRef.current.set(node, key);
        }
      };
      refCallbacks.current.set(key, callback);
    }
    return callback;
  };

  return {
    start,
    end,
    totalHeight: span.totalHeight,
    prefix: span.prefix,
    refFor,
  };
}

function measuresOf(keys: readonly string[], heights: readonly number[]): TurnMeasure[] {
  const items: TurnMeasure[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!key) continue;
    items.push({ key, height: heights[index] ?? 0 });
  }
  return items;
}

function totalOf(heights: readonly number[]): number {
  let total = 0;
  for (const height of heights) total += height;
  return total;
}
