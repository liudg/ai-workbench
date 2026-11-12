import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { EventViewProps } from "./types";

export function ReviewNote({ event }: EventViewProps) {
  if (event.kind !== "review-note") return null;
  return (
    <div className="event-in min-w-0 px-6 py-1.5">
      <p className="min-w-0 break-words whitespace-pre-wrap pl-6 text-xs leading-5 text-wb-fg-3">
        {event.text}
      </p>
    </div>
  );
}

export function ReviewFindings({ event }: EventViewProps) {
  if (event.kind !== "review-findings") return null;
  const findings = Array.isArray(event.findings) ? event.findings : [];
  return (
    <div className="event-in min-w-0 px-6 py-2">
      <div className="min-w-0 rounded-xl border border-wb-border bg-wb-card p-3.5">
        <p className="text-xs font-medium text-wb-fg-2">{DESKTOP_ZH.reviewTitle}</p>
        {event.summary ? (
          <p className="mt-1 break-words whitespace-pre-wrap text-sm leading-6 text-wb-fg">{event.summary}</p>
        ) : null}
        <div className="mt-2 space-y-3">
          {findings.map((finding, index) => (
            <div key={`${finding.location}-${index}`} className="min-w-0">
              <p className="break-words text-sm font-medium text-wb-fg">{finding.title}</p>
              {finding.location ? (
                <p className="break-all font-mono text-xs text-wb-fg-3">{finding.location}</p>
              ) : null}
              {finding.body ? (
                <p className="mt-1 break-words whitespace-pre-wrap text-sm leading-6 text-wb-fg-2">{finding.body}</p>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
