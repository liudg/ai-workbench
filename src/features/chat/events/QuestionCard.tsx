import { HelpCircle } from "lucide-react";

import { compactBlock, settledAnswerLine } from "./prompt-values";
import type { PromptBodyProps } from "./prompt-props";

/** 时间线里只留提问摘要。作答在浮层里，一次一道。 */
export function QuestionCard({ event, resolvedAnswer }: PromptBodyProps) {
  const source = event.questions.length > 0 ? event.questions : [{ id: "question", question: event.question }];
  const questions = source.flatMap((question) => {
    const text = compactBlock(question.question);
    return text ? [{ id: question.id, question: text }] : [];
  });
  return (
    <div className="min-w-0 rounded-xl border border-[var(--wb-warn-border)] bg-[var(--wb-warn-bg)] px-2.5 py-1.5">
      <div className="mb-1 flex min-w-0 items-center gap-2">
        <HelpCircle className="h-4 w-4 shrink-0 text-[var(--wb-warn-strong)]" />
        <span className="text-xs font-medium text-[var(--wb-warn-text)]">问题</span>
      </div>
      {questions.map((question) => (
        <p key={question.id} className="break-words whitespace-pre-wrap text-sm leading-5 text-[var(--wb-text-strong)]">
          {question.question}
        </p>
      ))}
      <p className="mt-0.5 break-words whitespace-pre-wrap text-xs leading-4 text-[var(--wb-muted)]">
        {settledAnswerLine(resolvedAnswer) ?? "等待回答…"}
      </p>
    </div>
  );
}
