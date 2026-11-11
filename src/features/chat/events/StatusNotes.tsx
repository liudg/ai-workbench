import { AlertCircle, Info, Lock } from "lucide-react";

import type { EventViewProps } from "./types";
import { visibleErrorText } from "./visible-error";

export function SystemNote({ event }: EventViewProps) {
  if (event.kind !== "system") return null;
  return (
    <div className="event-in min-w-0 px-6 py-1.5">
      <div className="flex min-w-0 gap-1.5 pl-6 text-xs leading-5 text-[var(--wb-muted)]">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        <p className="min-w-0 break-words whitespace-pre-wrap">{event.text}</p>
      </div>
    </div>
  );
}

export function ReadOnlyNote({ event }: EventViewProps) {
  if (event.kind !== "read-only") return null;
  return (
    <div className="event-in min-w-0 px-6 py-2">
      <div className="min-w-0 pl-6">
        <div className="flex min-w-0 items-start gap-2 rounded-xl border border-[var(--wb-warn-border)] bg-[var(--wb-warn-bg)] px-3 py-2 text-sm leading-6 text-[var(--wb-warn-text)]">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="min-w-0 break-words">{event.text}</p>
        </div>
      </div>
    </div>
  );
}

export function ErrorNote({ event }: EventViewProps) {
  if (event.kind !== "error") return null;
  const message = visibleErrorText(event.message);
  if (!message) return null;
  return (
    <div className="event-in min-w-0 px-6 py-2">
      <div className="min-w-0 pl-6">
        <div className="flex min-w-0 items-start gap-2 rounded-xl border border-[var(--wb-danger-border)] bg-[var(--wb-danger-bg)] px-3 py-2 text-sm text-[var(--wb-danger-text)]">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="min-w-0 break-words">{message}</p>
        </div>
      </div>
    </div>
  );
}
