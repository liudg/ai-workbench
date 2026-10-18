import { useEffect, useRef, useState, type RefObject } from "react";

import { isImeKey } from "../keyboard";
import { clearThreadHighlights, clearThreadMarks, paintThreadHits, scrollHitIntoView } from "./highlight";
import { collectTextHits, stepHit } from "./hits";
import { isThreadFindChord } from "./keyboard";

export const OPEN_THREAD_FIND = "ai-workbench:find-in-thread";

export function useThreadFind(rootRef: RefObject<HTMLElement | null>, layoutKey: string) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [count, setCount] = useState(0);
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
      const detail = (event as CustomEvent<{ query?: string }>).detail;
      setOpen(true);
      if (detail && typeof detail.query === "string") {
        indexRef.current = 0;
        setIndex(0);
        setQuery(detail.query);
        scrolledKey.current = "";
      }
      focusInput();
    };
    const onKey = (event: KeyboardEvent) => {
      if (isImeKey({ composing: event.isComposing, keyCode: event.keyCode })) return;
      if (!isThreadFindChord(event)) return;
      if (document.querySelector("[data-command-menu], [data-file-search]")) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
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
      const key = `${query}\n${bounded}\n${hits.length}`;
      if (scroll && hits[bounded] && scrolledKey.current !== key) {
        scrolledKey.current = key;
        scrollHitIntoView(hits[bounded], root);
      }
      observer.observe(root, { subtree: true, childList: true, characterData: true });
    };
    scan(true);
    return () => {
      observer.disconnect();
      clearThreadHighlights(root);
    };
  }, [layoutKey, open, query, index, rootRef]);

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
