import { Check, Circle } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { AssistantAnswer } from "../answer/AssistantAnswer";
import type { EventViewProps } from "./types";

function PlanMark({ status }: { status: string }) {
  if (status === "completed") {
    return <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-emerald-400" />;
  }
  if (status === "inProgress") {
    return <Circle className="mt-1 h-3.5 w-3.5 shrink-0 fill-zinc-200 text-zinc-200" />;
  }
  return <Circle className="mt-1 h-3.5 w-3.5 shrink-0 text-zinc-600" />;
}

export function PlanSteps({ event }: EventViewProps) {
  if (event.kind !== "plan-steps") return null;
  const explanation = event.explanation ?? "";
  return (
    <div className="event-in min-w-0 px-6 py-2">
      <div className="mx-auto min-w-0 max-w-3xl rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
        <p className="text-xs font-medium text-zinc-300">{DESKTOP_ZH.planTitle}</p>
        {explanation ? (
          <p className="mt-1 break-words whitespace-pre-wrap text-sm leading-6 text-zinc-400">{explanation}</p>
        ) : null}
        <ol className="mt-2 space-y-1.5">
          {event.steps.map((step, index) => (
            <li key={`${index}-${step.step}`} className="flex min-w-0 items-start gap-2 text-sm text-zinc-200">
              <PlanMark status={step.status} />
              <span className="min-w-0 break-words whitespace-pre-wrap">{step.step}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function PlanText({ event }: EventViewProps) {
  if (event.kind !== "plan-text") return null;
  return (
    <div className="event-in min-w-0 px-6 py-1">
      <div className="mx-auto min-w-0 max-w-3xl pl-6">
        <AssistantAnswer text={event.text} />
      </div>
    </div>
  );
}
