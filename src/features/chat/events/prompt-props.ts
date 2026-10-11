import type { PromptAnswer, Session, SessionEvent } from "@/types";

export type AnswerPrompt = (
  sessionId: string,
  promptId: string,
  answer: PromptAnswer,
) => void | Promise<void>;

export interface PromptBodyProps {
  event: Extract<SessionEvent, { kind: "prompt" }>;
  session: Session;
  resolvedAnswer: string | null;
  answerPrompt: AnswerPrompt;
}
