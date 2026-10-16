import { useEffect, useRef } from "react";

import { dismissTop, isDismissTop, pushDismissLayer } from "./dismiss-layer";

/** 浮层打开时占住 Esc。关掉自己，不把事件继续传给下面的层。 */
export function useDismissLayer(open: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const close = () => onCloseRef.current();
    const remove = pushDismissLayer(close);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !isDismissTop(close)) return;
      event.preventDefault();
      event.stopPropagation();
      dismissTop();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      remove();
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
}
