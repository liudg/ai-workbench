import { sessionStatusView } from "./session-status";

export function SessionStatusDot({ status }: { status: string | null | undefined }) {
  const view = sessionStatusView(status);
  if (!view) return null;
  if (view.marker === "ring") {
    return (
      <span
        title={view.word}
        aria-label={view.word}
        data-status-dot={view.tone}
        data-status-marker="ring"
        className={`inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center rounded-full border ${view.ringClass}`}
      >
        <span className={`h-1 w-1 rounded-full ${view.dotClass}`} />
      </span>
    );
  }
  return (
    <span
      title={view.word}
      aria-label={view.word}
      data-status-dot={view.tone}
      data-status-marker="dot"
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${view.dotClass}`}
    />
  );
}
