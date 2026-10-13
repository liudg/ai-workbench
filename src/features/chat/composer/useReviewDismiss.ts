import { useEffect, type RefObject } from "react";

export function useReviewDismiss(
  reviewOpen: boolean,
  reviewRootRef: RefObject<HTMLDivElement | null>,
  closeReview: () => void,
) {
  useEffect(() => {
    if (!reviewOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeReview();
    };
    const onPointer = (event: MouseEvent) => {
      // 选项的 mousedown 会立刻换掉菜单内容。旧节点已脱离文档时，
      // contains 判断会把这次点击当成菜单外。选项自己 preventDefault。
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
