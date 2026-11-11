import { Check, Circle } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { AssistantAnswer } from "../answer/AssistantAnswer";
import type { EventViewProps } from "./types";

function PlanMark({ status }: { status: string }) {
  if (status === "completed") {
    return <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--wb-success-strong)]" />;
  }
  if (status === "inProgress") {
    return <Circle className="mt-1 h-3.5 w-3.5 shrink-0 fill-[var(--wb-accent)] text-[var(--wb-accent)]" />;
  }
  return <Circle className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--wb-faint)]" />;
}

export function PlanSteps({ event }: EventViewProps) {
  if (event.kind !== "plan-steps") return null;
  const explanation = event.explanation ?? "";
  return (
    <div className="event-in min-w-0 px-6 py-2">
      <div className="min-w-0 pl-6">
        <div className="min-w-0 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-card)] p-3">
          <p className="text-xs font-medium text-[var(--wb-muted)]">{DESKTOP_ZH.planTitle}</p>
          {explanation ? (
            <p className="mt-1 break-words whitespace-pre-wrap text-sm leading-6 text-[var(--wb-text)]">{explanation}</p>
          ) : null}
          <ol className="mt-2 space-y-1.5">
            {event.steps.map((step, index) => (
              <li key={`${index}-${step.step}`} className="flex min-w-0 items-start gap-2 text-sm text-[var(--wb-text-strong)]">
                <PlanMark status={step.status} />
                <span className="min-w-0 break-words whitespace-pre-wrap">{step.step}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

export function PlanText({ event }: EventViewProps) {
  if (event.kind !== "plan-text") return null;
  return (
    <div className="event-in min-w-0 px-6 py-1">
      <div className="min-w-0 pl-6">
        <AssistantAnswer text={event.text} />
      </div>
    </div>
  );
}
