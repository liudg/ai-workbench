import { HelpCircle } from "lucide-react";

import { useWorkbench } from "@/store";
import { optionResolvedLabel, promptInteractive } from "./prompt-values";
import { ApprovalCard, ChoiceCard } from "./ApprovalCard";
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
    <div className="min-w-0 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3">
      <div className="mb-2 flex min-w-0 items-start gap-2">
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <p className="min-w-0 break-words whitespace-pre-wrap text-sm leading-6 text-zinc-200">{event.question}</p>
      </div>
      {interactive ? (
        event.prompt_kind === "free-text" ? (
          <FreeTextPrompt {...props} />
        ) : event.prompt_kind === "approval" ? (
          <ApprovalCard {...props} />
        ) : (
          <ChoiceCard {...props} />
        )
      ) : (
        <p className="min-w-0 break-words pl-6 text-xs text-zinc-500">
          {resolvedLabel ? `已回答：${resolvedLabel}` : "等待回答…"}
        </p>
      )}
    </div>
  );
}

/** 整条提问只在这里订阅一次 answerPrompt，卡片本身不再读 store。 */
export function PromptEvent({ event, session, resolvedAnswer }: EventViewProps) {
  const answerPrompt = useWorkbench((s) => s.answerPrompt);
  if (event.kind !== "prompt") return null;
  return (
    <div className="event-in min-w-0 px-6 py-2">
      <div className="mx-auto min-w-0 max-w-3xl pl-6">
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
