import { sessionStatusView } from "./session-status";

export function SessionStatusDot({ status }: { status: string | null | undefined }) {
  const view = sessionStatusView(status);
  if (!view) return null;
  return (
    <span
      title={view.word}
      aria-label={view.word}
      data-status-dot={view.tone}
      className={`inline-block shrink-0 rounded-full ${view.className}`}
    />
  );
}
