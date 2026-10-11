import { AlertCircle, Info, Lock } from "lucide-react";

import type { EventViewProps } from "./types";

export function SystemNote({ event }: EventViewProps) {
  if (event.kind !== "system") return null;
  return (
    <div className="event-in min-w-0 px-6 py-1.5">
      <div className="mx-auto flex min-w-0 max-w-3xl gap-1.5 text-xs leading-5 text-zinc-500">
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
      <div className="mx-auto flex min-w-0 max-w-3xl items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm leading-6 text-amber-100">
        <Lock className="mt-0.5 h-4 w-4 shrink-0" />
        <p className="min-w-0 break-words">{event.text}</p>
      </div>
    </div>
  );
}

export function ErrorNote({ event }: EventViewProps) {
  if (event.kind !== "error") return null;
  return (
    <div className="event-in min-w-0 px-6 py-2">
      <div className="mx-auto flex min-w-0 max-w-3xl items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.06] px-3 py-2 text-sm text-red-300">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <p className="min-w-0 break-words">{event.message}</p>
      </div>
    </div>
  );
}
