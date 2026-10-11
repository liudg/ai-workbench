import { useRef, useState } from "react";
import { HelpCircle, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { PromptQuestion } from "@/types";
import { filledQuestionAnswers } from "./prompt-values";
import type { PromptBodyProps } from "./prompt-props";

/** 问题卡片：适配器发出 prompt_kind=questions。点选项只填入回答框，「发送」一次提交整卡。 */
export function QuestionCard({ event, session, resolvedAnswer, answerPrompt }: PromptBodyProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const interactive = resolvedAnswer === null && session.status === "needs-input";

  const skip = () =>
    answerPrompt(session.id, event.prompt_id, {
      type: "questions",
      answers: {},
      skipped: true,
    });

  const submit = () => {
    const filled = filledQuestionAnswers(answers);
    if (Object.keys(filled).length === 0) return;
    answerPrompt(session.id, event.prompt_id, {
      type: "questions",
      answers: filled,
      skipped: false,
    });
  };

  const fillOption = (question: PromptQuestion, label: string) => {
    setAnswers((current) => ({ ...current, [question.id]: label }));
    inputRefs.current[question.id]?.focus();
  };

  const canSend = Object.values(answers).some((text) => text.trim().length > 0);

  return (
    <div className="min-w-0 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3">
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <HelpCircle className="h-4 w-4 shrink-0 text-amber-400" />
        <span className="text-xs font-medium text-zinc-400">问题</span>
        {interactive && (
          <button
            type="button"
            title="跳过"
            aria-label="跳过"
            className="ml-auto rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            onClick={skip}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {interactive ? (
        <>
          <div className="space-y-4">
            {event.questions.map((question, qIndex) => (
              <div key={question.id} className={cn(qIndex > 0 && "border-t border-amber-500/15 pt-3")}>
                {question.header && (
                  <p className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                    {question.header}
                  </p>
                )}
                <p className="break-words whitespace-pre-wrap text-sm leading-6 text-zinc-200">{question.question}</p>
                {question.options.length > 0 && (
                  <div className="mt-1.5 space-y-1">
                    {question.options.map((opt, index) => {
                      const selected = answers[question.id] === opt.label;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          title={opt.description || undefined}
                          className={cn(
                            "flex w-full min-w-0 items-baseline gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                            selected
                              ? "border-indigo-500/60 bg-indigo-500/15"
                              : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-800/70",
                          )}
                          onClick={() => fillOption(question, opt.label)}
                        >
                          <span
                            className={cn(
                              "shrink-0 font-mono text-xs tabular-nums",
                              selected ? "text-indigo-300" : "text-zinc-500",
                            )}
                          >
                            {index + 1}.
                          </span>
                          <span className="min-w-0 break-words">
                            <span className="block break-words text-sm text-zinc-200">{opt.label}</span>
                            {opt.description && (
                              <span className="block break-words text-xs leading-5 text-zinc-500">{opt.description}</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <Input
                  ref={(el) => {
                    inputRefs.current[question.id] = el;
                  }}
                  value={answers[question.id] ?? ""}
                  onChange={(e) =>
                    setAnswers((current) => ({
                      ...current,
                      [question.id]: e.target.value,
                    }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  type={question.is_secret ? "password" : "text"}
                  placeholder="或自行撰写回复"
                  className="mt-1.5 h-8"
                  autoFocus={qIndex === 0}
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={skip}>
              跳过
            </Button>
            <Button size="sm" onClick={submit} disabled={!canSend}>
              发送
            </Button>
          </div>
        </>
      ) : (
        <>
          {event.questions.map((question) => (
            <p key={question.id} className="break-words whitespace-pre-wrap text-sm leading-6 text-zinc-400">
              {question.question}
            </p>
          ))}
          <p className="mt-1 break-words whitespace-pre-wrap text-xs text-zinc-500">
            {resolvedAnswer ? `已回答：\n${resolvedAnswer}` : "等待回答…"}
          </p>
        </>
      )}
    </div>
  );
}
