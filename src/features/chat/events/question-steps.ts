import { isImeKey } from "../keyboard.ts";
import { filledQuestionAnswers } from "./prompt-values.ts";

/**
 * Codex 桌面端 `vz` / `sendUserMessageQuestion` 的答题步进。
 * request-input：单选默认第一项；点选项即前进；跳过时若已写自定义文本或多选有勾选则提交这些内容，否则清掉当前题。
 * async-reply：不预选；主按钮在没有答案时停住；跳过总是清掉当前题。
 * 关闭（Escape）整卡跳过，不带已经填在本地的答案。
 */

export type QuestionSurface = "request-input" | "async-reply";

export interface QuestionStepOption {
  id: string;
  label: string;
  disabled_reason?: string | null;
}

export interface QuestionStepItem {
  id: string;
  options: readonly QuestionStepOption[];
  is_other?: boolean;
  multi_select?: boolean;
  surface?: QuestionSurface;
}

export interface QuestionChoice {
  selectedId: string | null;
  selectedIds: string[];
  freeform: string;
}

export interface QuestionStepState {
  index: number;
  choices: QuestionChoice[];
}

export type QuestionStepEffect =
  | { type: "stay"; state: QuestionStepState }
  | { type: "advance"; state: QuestionStepState }
  | { type: "submit"; answers: Record<string, string>; skipped: boolean };

export type QuestionKeyFocus = "card" | "freeform" | "dismiss" | "field";

export type QuestionKeyAction =
  | { type: "none" }
  | { type: "dismiss" }
  | { type: "select"; index: number }
  | { type: "focus-freeform" }
  | { type: "page"; index: number }
  | { type: "move"; index: number }
  | { type: "submit" };

/** Codex 选项值以这 14 个字符结尾时，界面去掉后缀并显示「推荐」。 */
export const RECOMMENDED_SUFFIX = " (Recommended)";

export function optionPresentation(label: string): { label: string; recommended: boolean } {
  if (label.endsWith(RECOMMENDED_SUFFIX)) {
    return { label: label.slice(0, -RECOMMENDED_SUFFIX.length), recommended: true };
  }
  return { label, recommended: false };
}

function blankChoice(): QuestionChoice {
  return { selectedId: null, selectedIds: [], freeform: "" };
}

function initialChoice(question: QuestionStepItem): QuestionChoice {
  const surface = question.surface ?? "request-input";
  if (surface === "async-reply" || question.multi_select || question.options.length === 0) {
    return blankChoice();
  }
  return { selectedId: question.options[0]?.id ?? null, selectedIds: [], freeform: "" };
}

export function createQuestionStep(questions: readonly QuestionStepItem[]): QuestionStepState {
  return { index: 0, choices: questions.map((question) => initialChoice(question)) };
}

export function questionStepCursor(
  state: QuestionStepState,
  count: number,
): { index: number; isLast: boolean } {
  const index = count <= 0 ? 0 : Math.min(Math.max(state.index, 0), count - 1);
  return { index, isLast: count <= 1 || index >= count - 1 };
}

export function questionSurface(questions: readonly QuestionStepItem[]): QuestionSurface {
  return questions[0]?.surface ?? "request-input";
}

export function questionPopupTitle(surface: QuestionSurface, header: string, question: string): string {
  if (surface === "async-reply") return "问题";
  const label = header.trim();
  return label || question;
}

export function questionPopupPrimary(surface: QuestionSurface, isLast: boolean): string {
  if (surface === "async-reply") return isLast ? "发送" : "下一步";
  return isLast ? "提交" : "继续";
}

export function questionChoiceText(
  question: QuestionStepItem | undefined,
  choice: QuestionChoice | undefined,
): string {
  if (!question || !choice) return "";
  if (question.multi_select) {
    const labels = choice.selectedIds
      .map((id) => question.options.find((option) => option.id === id)?.label)
      .filter((label): label is string => Boolean(label));
    const freeform = choice.freeform.trim();
    if (freeform) labels.push(freeform);
    return labels.join(", ");
  }
  if (choice.selectedId) {
    const label = question.options.find((option) => option.id === choice.selectedId)?.label;
    if (label) return label;
  }
  return choice.freeform.trim();
}

function withChoice(
  state: QuestionStepState,
  index: number,
  choice: QuestionChoice,
): QuestionStepState {
  const choices = state.choices.slice();
  choices[index] = choice;
  return { ...state, choices };
}

function answersFrom(state: QuestionStepState, questions: readonly QuestionStepItem[]) {
  const answers: Record<string, string> = {};
  questions.forEach((question, index) => {
    const text = questionChoiceText(question, state.choices[index]);
    if (text) answers[question.id] = text;
  });
  return filledQuestionAnswers(answers);
}

function commit(state: QuestionStepState, questions: readonly QuestionStepItem[]): QuestionStepEffect {
  if (questions.length === 0) return { type: "submit", answers: {}, skipped: true };
  const { index, isLast } = questionStepCursor(state, questions.length);
  const answers = answersFrom(state, questions);
  if (!isLast) {
    return { type: "advance", state: { ...state, index: index + 1 } };
  }
  if (Object.keys(answers).length === 0) return { type: "submit", answers: {}, skipped: true };
  return { type: "submit", answers, skipped: false };
}

function chooseOption(
  state: QuestionStepState,
  questions: readonly QuestionStepItem[],
  optionId: string,
): QuestionStepState | null {
  if (questions.length === 0) return null;
  const { index } = questionStepCursor(state, questions.length);
  const question = questions[index];
  const option = question?.options.find((item) => item.id === optionId);
  if (!question || !option || option.disabled_reason) return null;
  const current = state.choices[index] ?? blankChoice();
  if (question.multi_select) {
    const selectedIds = current.selectedIds.includes(optionId)
      ? current.selectedIds.filter((id) => id !== optionId)
      : [...current.selectedIds, optionId];
    return withChoice(state, index, {
      ...current,
      selectedIds,
        selectedId: selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null,
    });
  }
  return withChoice(state, index, { ...current, selectedId: optionId });
}

/** 方向键只改当前题的选择，不提交。多选是切换勾选。 */
export function highlightQuestionOption(
  state: QuestionStepState,
  questions: readonly QuestionStepItem[],
  optionId: string,
): QuestionStepEffect {
  const next = chooseOption(state, questions, optionId);
  if (!next) return { type: "stay", state };
  return { type: "advance", state: next };
}

/** 数字键和单击。单选会前进或提交；多选只切换勾选。 */
export function selectQuestionOption(
  state: QuestionStepState,
  questions: readonly QuestionStepItem[],
  optionId: string,
): QuestionStepEffect {
  const next = chooseOption(state, questions, optionId);
  if (!next) return { type: "stay", state };
  const { index } = questionStepCursor(state, questions.length);
  if (questions[index]?.multi_select) return { type: "advance", state: next };
  return commit(next, questions);
}

export function setQuestionFreeform(
  state: QuestionStepState,
  questions: readonly QuestionStepItem[],
  text: string,
): QuestionStepState {
  if (questions.length === 0) return state;
  const { index } = questionStepCursor(state, questions.length);
  const question = questions[index];
  const current = state.choices[index] ?? blankChoice();
  const clearSelection = Boolean(question?.is_other) && !question?.multi_select;
  return withChoice(state, index, {
    ...current,
    freeform: text,
    selectedId: clearSelection ? null : current.selectedId,
  });
}

export function focusQuestionFreeform(
  state: QuestionStepState,
  questions: readonly QuestionStepItem[],
): QuestionStepState {
  if (questions.length === 0) return state;
  const { index } = questionStepCursor(state, questions.length);
  const question = questions[index];
  if (!question?.is_other || question.multi_select) return state;
  const current = state.choices[index] ?? blankChoice();
  return withChoice(state, index, { ...current, selectedId: null });
}

export function pageQuestion(
  state: QuestionStepState,
  questions: readonly QuestionStepItem[],
  nextIndex: number,
): QuestionStepEffect {
  if (questions.length <= 1) return { type: "stay", state };
  const index = Math.min(Math.max(nextIndex, 0), questions.length - 1);
  if (index === questionStepCursor(state, questions.length).index) return { type: "stay", state };
  return { type: "advance", state: { ...state, index } };
}

export function continueQuestionStep(
  state: QuestionStepState,
  questions: readonly QuestionStepItem[],
): QuestionStepEffect {
  if (questions.length === 0) return { type: "stay", state };
  if (questionSurface(questions) === "async-reply") {
    const { index } = questionStepCursor(state, questions.length);
    if (!questionChoiceText(questions[index], state.choices[index])) return { type: "stay", state };
  }
  return commit(state, questions);
}

export function skipQuestionStep(
  state: QuestionStepState,
  questions: readonly QuestionStepItem[],
): QuestionStepEffect {
  if (questions.length === 0) return { type: "submit", answers: {}, skipped: true };
  const { index } = questionStepCursor(state, questions.length);
  const question = questions[index];
  const choice = state.choices[index] ?? blankChoice();
  const surface = questionSurface(questions);
  if (surface !== "async-reply" && question) {
    const typed = choice.freeform.trim().length > 0;
    const picked = Boolean(question.multi_select) && choice.selectedIds.length > 0;
    if (typed || picked) return continueQuestionStep(state, questions);
  }
  return commit(withChoice(state, index, blankChoice()), questions);
}

export function dismissQuestionStep(): QuestionStepEffect {
  return { type: "submit", answers: {}, skipped: true };
}

export function questionKeyAction(input: {
  key: string;
  composing: boolean;
  keyCode?: number;
  focus: QuestionKeyFocus;
  questionCount: number;
  questionIndex: number;
  optionCount: number;
  selectedIndex: number;
  isOther: boolean;
  hasOptions: boolean;
  multi: boolean;
}): QuestionKeyAction {
  const { key, focus } = input;
  if (isImeKey(input)) return { type: "none" };
  if (key === "Escape") return { type: "dismiss" };
  if (focus === "dismiss") return { type: "none" };
  if (focus === "freeform") {
    if (key === "ArrowUp" && input.hasOptions) {
      return { type: "move", index: input.optionCount - 1 };
    }
    if (key === "Enter") return { type: "submit" };
    return { type: "none" };
  }
  if (focus === "field" && key !== "Enter") return { type: "none" };
  if (key >= "1" && key <= "9") {
    const index = Number(key) - 1;
    if (index < input.optionCount) return { type: "select", index };
    if (input.isOther && input.hasOptions && index === input.optionCount) return { type: "focus-freeform" };
    return { type: "none" };
  }
  if (key === "ArrowLeft" || key === "ArrowRight") {
    if (input.questionCount <= 1) return { type: "none" };
    const delta = key === "ArrowRight" ? 1 : -1;
    const index = Math.min(Math.max(input.questionIndex + delta, 0), input.questionCount - 1);
    return { type: "page", index };
  }
  if (key === "ArrowDown" || key === "ArrowUp") {
    if (!input.hasOptions || (key === "ArrowUp" && input.selectedIndex === 0)) return { type: "none" };
    const delta = key === "ArrowDown" ? 1 : -1;
    if (key === "ArrowDown" && input.selectedIndex === input.optionCount - 1 && input.isOther) {
      return { type: "focus-freeform" };
    }
    if (key === "ArrowDown" && input.isOther && input.selectedIndex < 0) return { type: "focus-freeform" };
    const raw = input.selectedIndex < 0 ? (delta > 0 ? 0 : input.optionCount - 1) : input.selectedIndex + delta;
    const index = Math.min(Math.max(raw, 0), input.optionCount - 1);
    return { type: "move", index };
  }
  if (key === "Enter") {
    if (input.multi || input.selectedIndex < 0) return { type: "submit" };
    return { type: "select", index: input.selectedIndex };
  }
  return { type: "none" };
}
