export function ColumnSplitter({
  name,
  onDelta,
}: {
  name: "chat-preview" | "diff-files" | "open-files";
  onDelta: (dx: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={name === "chat-preview" ? "调整预览宽度" : "调整文件列宽度"}
      data-resize={name}
      className="relative z-20 w-1.5 shrink-0 cursor-col-resize bg-zinc-900 hover:bg-zinc-600"
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
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
      }}
    />
  );
}
