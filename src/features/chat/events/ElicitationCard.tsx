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
  // 必填项没填时「接受」按钮不可点，而不是点了没反应。
  const filled = elicitationContent(event.questions, values, flags);

  const submit = (action: "accept" | "decline" | "cancel") => {
    if (action !== "accept") {
      answerPrompt(session.id, event.prompt_id, { type: "elicitation", action });
      return;
    }
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
        "min-w-0 overflow-x-hidden rounded-lg border border-amber-500/25 bg-amber-500/[0.06]",
        interactive ? "p-3" : "px-2.5 py-1.5",
      )}
    >
      <p
        className={cn(
          "min-w-0 break-words whitespace-pre-wrap text-sm text-zinc-200",
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
                <span className="mb-1 block break-words text-xs text-zinc-400">
                  {question.header || question.id}
                  {question.required ? " *" : ""}
                </span>
                {question.question && question.question !== question.header ? (
                  <span className="mb-1 block break-words text-[11px] text-zinc-500">{question.question}</span>
                ) : null}
                {question.input_kind === "boolean" ? (
                  <input
                    type="checkbox"
                    checked={Boolean(flags[question.id])}
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
                    className="h-8 w-full min-w-0 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-200"
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
            <Button type="button" size="sm" className="h-8" disabled={!filled.ok} onClick={() => submit("accept")}>
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
        <p className="mt-0.5 break-words whitespace-pre-wrap text-xs leading-4 text-zinc-500">
          {settledAnswerLine(resolvedAnswer) ?? "等待回答…"}
        </p>
      )}
    </div>
  );
}
