import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { EventViewProps } from "./types";

export function ReviewNote({ event }: EventViewProps) {
  if (event.kind !== "review-note") return null;
  return (
    <div className="event-in min-w-0 px-6 py-1.5">
      <p className="mx-auto min-w-0 max-w-3xl break-words whitespace-pre-wrap pl-6 text-xs leading-5 text-zinc-500">
        {event.text}
      </p>
    </div>
  );
}

export function ReviewFindings({ event }: EventViewProps) {
  if (event.kind !== "review-findings") return null;
  return (
    <div className="event-in min-w-0 px-6 py-2">
      <div className="mx-auto min-w-0 max-w-3xl rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
        <p className="text-xs font-medium text-zinc-300">{DESKTOP_ZH.reviewTitle}</p>
        {event.summary ? (
          <p className="mt-1 break-words whitespace-pre-wrap text-sm leading-6 text-zinc-200">{event.summary}</p>
        ) : null}
        <div className="mt-2 space-y-3">
          {event.findings.map((finding, index) => (
            <div key={`${finding.location}-${index}`} className="min-w-0">
              <p className="break-words text-sm text-zinc-100">{finding.title}</p>
              {finding.location ? (
                <p className="break-all font-mono text-xs text-zinc-500">{finding.location}</p>
              ) : null}
              {finding.body ? (
                <p className="mt-1 break-words whitespace-pre-wrap text-sm leading-6 text-zinc-400">{finding.body}</p>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
