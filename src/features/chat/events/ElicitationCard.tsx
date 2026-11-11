import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { compactBlock, elicitationContent, promptInteractive, settledAnswerLine } from "./prompt-values";
import type { PromptBodyProps } from "./prompt-props";

export function ElicitationCard({ event, session, resolvedAnswer, answerPrompt }: PromptBodyProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const interactive = promptInteractive(resolvedAnswer, session.status);

  const submit = (action: "accept" | "decline" | "cancel") => {
    if (action !== "accept") {
      answerPrompt(session.id, event.prompt_id, { type: "elicitation", action });
      return;
    }
    const filled = elicitationContent(event.questions, values, flags);
    if (!filled.ok) return;
    answerPrompt(session.id, event.prompt_id, {
      type: "elicitation",
      action: "accept",
      content: filled.content,
    });
  };

  return (
    <div
      className={cn(
        "min-w-0 overflow-x-hidden rounded-xl border border-[var(--wb-warn-border)] bg-[var(--wb-warn-bg)]",
        interactive ? "p-3" : "px-2.5 py-1.5",
      )}
    >
      <p
        className={cn(
          "min-w-0 break-words whitespace-pre-wrap text-sm text-[var(--wb-text-strong)]",
          interactive ? "leading-6" : "leading-5",
        )}
      >
        {interactive ? event.question : compactBlock(event.question)}
      </p>
      {interactive ? (
        <>
          <div className="mt-3 space-y-3">
            {event.questions.map((question) => (
              <label key={question.id} className="block min-w-0">
                <span className="mb-1 block break-words text-xs font-medium text-[var(--wb-text)]">
                  {question.header || question.id}
                  {question.required ? " *" : ""}
                </span>
                {question.question && question.question !== question.header ? (
                  <span className="mb-1 block break-words text-[11px] text-[var(--wb-muted)]">
                    {question.question}
                  </span>
                ) : null}
                {question.input_kind === "boolean" ? (
                  <input
                    type="checkbox"
                    checked={Boolean(flags[question.id])}
                    className="h-4 w-4 rounded border-[var(--wb-border-strong)] bg-[var(--wb-well)] accent-[var(--wb-accent)]"
                    onChange={(change) =>
                      setFlags((current) => ({
                        ...current,
                        [question.id]: change.target.checked,
                      }))
                    }
                  />
                ) : question.options.length > 0 ? (
                  <select
                    aria-label={question.header || question.id}
                    value={values[question.id] ?? ""}
                    className="h-8 w-full min-w-0 rounded-lg border border-[var(--wb-border-strong)] bg-[var(--wb-well)] px-2.5 text-sm text-[var(--wb-text-strong)] outline-none transition-colors focus:border-[var(--wb-accent)] focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/20"
                    onChange={(change) =>
                      setValues((current) => ({
                        ...current,
                        [question.id]: change.target.value,
                      }))
                    }
                  >
                    <option value="" />
                    {question.options.map((option) => (
                      <option key={option.id} value={option.label}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    type={
                      question.is_secret
                        ? "password"
                        : question.input_kind === "number" || question.input_kind === "integer"
                          ? "number"
                          : "text"
                    }
                    value={values[question.id] ?? ""}
                    aria-label={question.header || question.id}
                    className="h-8 min-w-0"
                    onChange={(change) =>
                      setValues((current) => ({
                        ...current,
                        [question.id]: change.target.value,
                      }))
                    }
                  />
                )}
              </label>
            ))}
          </div>
          <div className="mt-3 flex min-w-0 flex-wrap gap-2">
            <Button type="button" size="sm" className="h-8" onClick={() => submit("accept")}>
              {DESKTOP_ZH.elicitAccept}
            </Button>
            <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => submit("decline")}>
              {DESKTOP_ZH.elicitDecline}
            </Button>
            <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => submit("cancel")}>
              {DESKTOP_ZH.elicitCancel}
            </Button>
          </div>
        </>
      ) : (
        <p className="mt-0.5 break-words whitespace-pre-wrap text-xs leading-4 text-[var(--wb-muted)]">
          {settledAnswerLine(resolvedAnswer) ?? "等待回答…"}
        </p>
      )}
    </div>
  );
}
