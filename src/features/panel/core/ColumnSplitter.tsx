import { useEffect, useRef } from "react";

import { columnDragDelta } from "./layout";

export function ColumnSplitter({
  name,
  onDelta,
  onSettle,
}: {
  name: "chat-preview" | "diff-files" | "open-files";
  onDelta: (dx: number) => void;
  onSettle?: () => void;
}) {
  const endRef = useRef<(() => void) | null>(null);
  const settleRef = useRef(onSettle);
  settleRef.current = onSettle;
  useEffect(() => () => endRef.current?.(), []);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={name === "chat-preview" ? "调整预览宽度" : "调整文件列宽度"}
      tabIndex={0}
      data-resize={name}
      className="group relative z-20 w-1.5 shrink-0 cursor-col-resize touch-none bg-transparent outline-none before:absolute before:inset-y-0 before:-left-1.5 before:-right-1.5 before:content-[''] after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-[var(--wb-border)] after:transition-all hover:after:w-0.5 hover:after:bg-[var(--wb-accent)] focus-visible:after:w-0.5 focus-visible:after:bg-[var(--wb-accent)]"
      onKeyDown={(event) => {
        const key = event.key === "ArrowLeft" || event.key === "ArrowRight" ? event.key : null;
        if (!key) return;
        event.preventDefault();
        onDelta(columnDragDelta(key, event.shiftKey));
      }}
      onKeyUp={() => settleRef.current?.()}
      onBlur={() => settleRef.current?.()}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        let last = event.clientX;
        const move = (next: PointerEvent) => {
          const dx = next.clientX - last;
          last = next.clientX;
          if (dx !== 0) onDelta(dx);
        };
        const end = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", end);
          handle.removeEventListener("pointercancel", end);
          if (endRef.current === end) endRef.current = null;
          settleRef.current?.();
        };
        endRef.current?.();
        endRef.current = end;
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
      }}
    />
  );
}
