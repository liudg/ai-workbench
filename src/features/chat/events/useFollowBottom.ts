import { useLayoutEffect, useRef } from "react";

const PINNED_SLACK = 8;

/**
 * 输出还在长时贴着框底。用户往上翻就不再拉回去，翻回底部再接着跟。
 * `content` 变了才重新对齐；`follow` 为假时不动滚动位置。
 */
export function useFollowBottom<T extends HTMLElement>(follow: boolean, content: string) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !follow || !pinned.current) return;
    el.scrollTop = el.scrollHeight;
  }, [follow, content]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= PINNED_SLACK;
  };

  return { ref, onScroll };
}
