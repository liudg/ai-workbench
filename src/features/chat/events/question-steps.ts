import { filledQuestionAnswers } from "./prompt-values.ts";

/**
 * 一道题一个步。非末题的「发送」只把草稿收进本地答案并前进。
 * 末题发送才整卡提交。跳过丢掉当前题；前面有答案就带上，全空则整卡跳过。
 * 关闭是整卡跳过，不提交已经填在本地的答案。
 */
export interface QuestionStepState {
  index: number;
  answers: Record<string, string>;
  draft: string;
}

export interface QuestionStepItem {
  id: string;
}

export type QuestionStepEffect =
  | { type: "stay"; state: QuestionStepState }
  | { type: "advance"; state: QuestionStepState }
  | { type: "submit"; answers: Record<string, string>; skipped: boolean };

export function createQuestionStep(): QuestionStepState {
  return { index: 0, answers: {}, draft: "" };
}

export function questionStepCursor(
  state: QuestionStepState,
  count: number,
): { index: number; isLast: boolean } {
  const index = count <= 0 ? 0 : Math.min(Math.max(state.index, 0), count - 1);
  return { index, isLast: count <= 1 || index >= count - 1 };
}

export function sendQuestionStep(
  state: QuestionStepState,
  questions: readonly QuestionStepItem[],
): QuestionStepEffect {
  const text = state.draft.trim();
  if (!text || questions.length === 0) return { type: "stay", state };
  const { index, isLast } = questionStepCursor(state, questions.length);
  const answers = { ...state.answers, [questions[index].id]: text };
  if (!isLast) {
    return { type: "advance", state: { index: index + 1, answers, draft: "" } };
  }
  return { type: "submit", answers: filledQuestionAnswers(answers), skipped: false };
}

export function skipQuestionStep(
  state: QuestionStepState,
  questions: readonly QuestionStepItem[],
): QuestionStepEffect {
  if (questions.length === 0) return { type: "submit", answers: {}, skipped: true };
  const { index, isLast } = questionStepCursor(state, questions.length);
  const answers = { ...state.answers };
  delete answers[questions[index].id];
  if (!isLast) {
    return { type: "advance", state: { index: index + 1, answers, draft: "" } };
  }
  const filled = filledQuestionAnswers(answers);
  if (Object.keys(filled).length === 0) return { type: "submit", answers: {}, skipped: true };
  return { type: "submit", answers: filled, skipped: false };
}

export function dismissQuestionStep(): QuestionStepEffect {
  return { type: "submit", answers: {}, skipped: true };
}
