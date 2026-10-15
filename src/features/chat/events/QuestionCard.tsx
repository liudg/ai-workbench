import { HelpCircle } from "lucide-react";

import type { PromptBodyProps } from "./prompt-props";

/** 时间线里只留提问摘要。作答在浮层里，一次一道。 */
export function QuestionCard({ event, resolvedAnswer }: PromptBodyProps) {
  const questions = event.questions.length > 0 ? event.questions : [{ id: "question", question: event.question }];
  return (
    <div className="min-w-0 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3">
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <HelpCircle className="h-4 w-4 shrink-0 text-amber-400" />
        <span className="text-xs font-medium text-zinc-400">问题</span>
      </div>
      {questions.map((question) => (
        <p key={question.id} className="break-words whitespace-pre-wrap text-sm leading-6 text-zinc-400">
          {question.question}
        </p>
      ))}
      <p className="mt-1 break-words whitespace-pre-wrap text-xs text-zinc-500">
        {resolvedAnswer ? `已回答：\n${resolvedAnswer}` : "等待回答…"}
      </p>
    </div>
  );
}
