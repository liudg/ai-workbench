import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { EventViewProps } from "./types";

export function ReviewNote({ event }: EventViewProps) {
  if (event.kind !== "review-note") return null;
  return (
    <div className="event-in min-w-0 px-6 py-1.5">
      <p className="min-w-0 break-words whitespace-pre-wrap pl-6 text-xs leading-5 text-[var(--wb-muted)]">
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
      <div className="min-w-0 pl-6">
        <div className="min-w-0 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-card)] p-3">
          <p className="text-xs font-medium text-[var(--wb-muted)]">{DESKTOP_ZH.reviewTitle}</p>
          {event.summary ? (
            <p className="mt-1 break-words whitespace-pre-wrap text-sm leading-6 text-[var(--wb-text-strong)]">{event.summary}</p>
          ) : null}
          <div className="mt-2 space-y-3">
            {findings.map((finding, index) => (
              <div key={`${finding.location}-${index}`} className="min-w-0">
                <p className="break-words text-sm font-medium text-[var(--wb-text-strong)]">{finding.title}</p>
                {finding.location ? (
                  <p className="break-all font-mono text-xs text-[var(--wb-muted)]">{finding.location}</p>
                ) : null}
                {finding.body ? (
                  <p className="mt-1 break-words whitespace-pre-wrap text-sm leading-6 text-[var(--wb-text)]">{finding.body}</p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
