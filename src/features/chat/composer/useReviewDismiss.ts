import { useEffect, type RefObject } from "react";

import { isImeKey } from "../keyboard";

export function useReviewDismiss(
  reviewOpen: boolean,
  reviewRootRef: RefObject<HTMLDivElement | null>,
  closeReview: () => void,
) {
  useEffect(() => {
    if (!reviewOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        isImeKey({ composing: event.isComposing, keyCode: event.keyCode }) ||
        event.defaultPrevented
      ) {
        return;
      }
      event.preventDefault();
      closeReview();
    };
    const onPointer = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      if (reviewRootRef.current?.contains(event.target as Node)) return;
      closeReview();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [reviewOpen, reviewRootRef, closeReview]);
}
