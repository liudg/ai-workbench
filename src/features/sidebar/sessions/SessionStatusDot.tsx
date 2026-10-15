import { sessionStatusView } from "./session-status";

export function SessionStatusDot({ status }: { status: string | null | undefined }) {
  const view = sessionStatusView(status);
  if (!view) return null;
  if (view.marker === "spinner") {
    return (
      <span
        title={view.word}
        aria-label={view.word}
        data-status-dot={view.tone}
        data-status-marker="spinner"
        className={`inline-flex h-3 w-3 shrink-0 items-center justify-center ${view.ringClass}`}
      >
        <svg viewBox="0 0 16 16" className="h-3 w-3 animate-spin" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.5" />
          <path
            d="M8 2a6 6 0 1 1-6 6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }
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
