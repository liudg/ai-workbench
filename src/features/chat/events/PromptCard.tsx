import { HelpCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAnswerPrompt } from "./useAnswerPrompt";
import { compactBlock, optionResolvedLabel, promptInteractive, settledAnswerLine } from "./prompt-values";
import { ChoiceCard } from "./ApprovalCard";
import { isPinnedChoice } from "./pending-plan-choice";
import { ElicitationCard } from "./ElicitationCard";
import { FreeTextPrompt } from "./FreeTextPrompt";
import { QuestionCard } from "./QuestionCard";
import type { PromptBodyProps } from "./prompt-props";
import type { EventViewProps } from "./types";

function PromptBody(props: PromptBodyProps) {
  const { event, resolvedAnswer, session } = props;
  if (event.prompt_kind === "elicitation") return <ElicitationCard {...props} />;
  if (event.prompt_kind === "questions") return <QuestionCard {...props} />;

  const interactive = promptInteractive(resolvedAnswer, session.status);
  const resolvedLabel = optionResolvedLabel(event.options, resolvedAnswer);
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg border border-amber-500/25 bg-amber-500/[0.06]",
        interactive ? "p-3" : "px-2.5 py-1.5",
      )}
    >
      <div className={cn("flex min-w-0 items-start gap-2", interactive ? "mb-2" : "mb-1")}>
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <p
          className={cn(
            "min-w-0 break-words whitespace-pre-wrap text-sm text-zinc-200",
            interactive ? "leading-6" : "leading-5",
          )}
        >
          {interactive ? event.question : compactBlock(event.question)}
        </p>
      </div>
      {interactive ? (
        event.prompt_kind === "free-text" ? (
          <FreeTextPrompt {...props} />
        ) : (
          <ChoiceCard {...props} />
        )
      ) : (
        <p className="min-w-0 break-words whitespace-pre-wrap pl-6 text-xs leading-4 text-zinc-500">
          {settledAnswerLine(resolvedLabel) ?? "等待回答…"}
        </p>
      )}
    </div>
  );
}

/** 整条提问只在这里订阅一次 answerPrompt，卡片本身不再读 store。 */
export function PromptEvent({ event, session, resolvedAnswer }: EventViewProps) {
  const answerPrompt = useAnswerPrompt();
  if (event.kind !== "prompt" || event.prompt_kind === "approval" || isPinnedChoice(event)) return null;
  return (
    <div className="event-in min-w-0 px-6 py-2">
      <div className="min-w-0 pl-6">
        <PromptBody
          event={event}
          session={session}
          resolvedAnswer={resolvedAnswer}
          answerPrompt={answerPrompt}
        />
      </div>
    </div>
  );
}
