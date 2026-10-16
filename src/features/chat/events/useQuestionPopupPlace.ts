import { useLayoutEffect, useRef, useState } from "react";

import { placeQuestionPopup, type QuestionPopupPlace } from "./question-popup-place";

/** 提问卡片跟着作曲栏走。锚点还没挂上时不占位置。 */
export function useQuestionPopupPlace(anchor: HTMLElement | null): QuestionPopupPlace | null {
  const [place, setPlace] = useState<QuestionPopupPlace | null>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  useLayoutEffect(() => {
    const node = anchorRef.current;
    if (!node) {
      setPlace(null);
      return;
    }
    const update = () => {
      const current = anchorRef.current;
      if (!current) return;
      const rect = current.getBoundingClientRect();
      const column = current.closest("[data-chat-column]");
      const header = column?.querySelector("[data-chat-header]");
      const ceiling = header instanceof HTMLElement ? header.getBoundingClientRect().bottom + 8 : 8;
      const next = placeQuestionPopup(
        { left: rect.left, top: rect.top, width: rect.width },
        { width: window.innerWidth, height: window.innerHeight },
        ceiling,
      );
      setPlace((previous) =>
        previous &&
        previous.left === next.left &&
        previous.width === next.width &&
        previous.bottom === next.bottom &&
        previous.maxHeight === next.maxHeight
          ? previous
          : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    const column = node.closest("[data-chat-column]");
    if (column) observer.observe(column);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor]);
  return place;
}
