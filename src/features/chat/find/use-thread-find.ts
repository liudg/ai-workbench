import { useEffect, useRef, useState, type RefObject } from "react";

import { sameChatScope } from "../chat-scope";
import { isImeKey } from "../keyboard";
import { clearThreadHighlights, clearThreadMarks, paintThreadHits, scrollCurrentHitIntoView } from "./highlight";
import { collectTextHits, stepHit } from "./hits";
import { isThreadFindChord } from "./keyboard";

export const OPEN_THREAD_FIND = "ai-workbench:find-in-thread";

/** 同屏有几段聊天时，查找只在焦点所在的那段打开。 */
function ownsFocus(root: HTMLElement | null): boolean {
  return sameChatScope(root, document.activeElement);
}

export function useThreadFind(
  rootRef: RefObject<HTMLElement | null>,
  layoutKey: string,
  onNavigate: () => void,
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [count, setCount] = useState(0);
  const [navigation, setNavigation] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const indexRef = useRef(0);
  const scrolledKey = useRef("");

  const focusInput = () => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  useEffect(() => {
    const onOpen = (event: Event) => {
      if (!ownsFocus(rootRef.current)) return;
      const detail = (event as CustomEvent<{ query?: string }>).detail;
      setOpen(true);
      scrolledKey.current = "";
      setNavigation((value) => value + 1);
      if (detail && typeof detail.query === "string") {
        indexRef.current = 0;
        setIndex(0);
        setQuery(detail.query);
      }
      focusInput();
    };
    const onKey = (event: KeyboardEvent) => {
      if (isImeKey({ composing: event.isComposing, keyCode: event.keyCode })) return;
      if (!isThreadFindChord(event)) return;
      if (!ownsFocus(rootRef.current)) return;
      if (document.querySelector("[data-command-menu], [data-file-search]")) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
      scrolledKey.current = "";
      setNavigation((value) => value + 1);
      focusInput();
    };
    window.addEventListener(OPEN_THREAD_FIND, onOpen);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener(OPEN_THREAD_FIND, onOpen);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!open || !root) {
      if (root) clearThreadHighlights(root);
      setCount(0);
      return;
    }
    let scrollFrame: number | undefined;
    const observer = new MutationObserver(() => scan(false));
    const scan = (scroll: boolean) => {
      observer.disconnect();
      clearThreadMarks(root);
      const hits = collectTextHits(root, query);
      const bounded = hits.length === 0 ? 0 : Math.min(indexRef.current, hits.length - 1);
      if (bounded !== indexRef.current) {
        indexRef.current = bounded;
        setIndex(bounded);
      }
      setCount((previous) => (previous === hits.length ? previous : hits.length));
      paintThreadHits(hits, hits.length === 0 ? -1 : bounded);
      const key = `${query}\n${bounded}`;
      if (scroll && hits[bounded] && scrolledKey.current !== key) {
        // 等虚拟列表完成本轮布局；回调里取当前 mark，避免重扫后拿到旧节点。
        scrollFrame = requestAnimationFrame(() => {
          if (scrollCurrentHitIntoView(root)) {
            scrolledKey.current = key;
            onNavigate();
          }
        });
      }
      observer.observe(root, { subtree: true, childList: true, characterData: true });
    };
    scan(true);
    return () => {
      observer.disconnect();
      if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
      clearThreadHighlights(root);
    };
  }, [layoutKey, open, query, index, navigation, rootRef, onNavigate]);

  const close = () => {
    setOpen(false);
    const root = rootRef.current;
    if (root) clearThreadHighlights(root);
  };

  const onQuery = (value: string) => {
    indexRef.current = 0;
    setIndex(0);
    scrolledKey.current = "";
    setQuery(value);
  };

  const move = (direction: 1 | -1) => {
    if (count <= 0) return;
    const next = stepHit(indexRef.current, count, direction);
    indexRef.current = next;
    scrolledKey.current = "";
    setIndex(next);
    // 一个结果时索引不会变，但每次导航仍要把它带回视口。
    setNavigation((value) => value + 1);
  };

  return {
    open,
    query,
    index,
    count,
    inputRef,
    onQuery,
    onNext: () => move(1),
    onPrevious: () => move(-1),
    close,
  };
}
