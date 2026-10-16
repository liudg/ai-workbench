import assert from "node:assert/strict";
import { test } from "node:test";

import {
  continueQuestionStep,
  createQuestionStep,
  dismissQuestionStep,
  optionPresentation,
  pageQuestion,
  questionChoiceText,
  questionKeyAction,
  selectQuestionOption,
  setQuestionFreeform,
  skipQuestionStep,
  type QuestionStepItem,
} from "./question-steps.ts";

const options = [
  { id: "vite", label: "Vite" },
  { id: "next", label: "Next.js" },
];

function item(id: string, patch: Partial<QuestionStepItem> = {}): QuestionStepItem {
  return { id, options, ...patch };
}

const blocking = [item("q1"), item("q2"), item("q3", { options: [] })];
const asyncQuestions = blocking.map((question) => ({ ...question, surface: "async-reply" as const, is_other: question.options.length > 0 }));

test("request-input starts on the first option and continue keeps it", () => {
  const state = createQuestionStep(blocking);
  assert.equal(questionChoiceText(blocking[0], state.choices[0]), "Vite");
  const effect = continueQuestionStep(state, blocking);
  assert.deepEqual(effect, {
    type: "advance",
    state: { index: 1, choices: state.choices },
  });
});

test("choosing a single option advances, and the last one submits", () => {
  const first = selectQuestionOption(createQuestionStep(blocking), blocking, "next");
  assert.equal(first.type, "advance");
  if (first.type !== "advance") return;
  assert.equal(questionChoiceText(blocking[0], first.state.choices[0]), "Next.js");
  const second = selectQuestionOption(first.state, blocking, "vite");
  assert.equal(second.type, "advance");
  if (second.type !== "advance") return;
  const typed = setQuestionFreeform(second.state, blocking, "  ship it  ");
  assert.deepEqual(continueQuestionStep(typed, blocking), {
    type: "submit",
    answers: { q1: "Next.js", q2: "Vite", q3: "ship it" },
    skipped: false,
  });
});

test("custom text clears the selected option when is_other is set", () => {
  const questions = [item("q1", { is_other: true })];
  const typed = setQuestionFreeform(createQuestionStep(questions), questions, "自己写");
  assert.equal(typed.choices[0]?.selectedId, null);
  assert.deepEqual(continueQuestionStep(typed, questions), {
    type: "submit",
    answers: { q1: "自己写" },
    skipped: false,
  });
});

test("options without is_other keep the selection ahead of leftover freeform", () => {
  const questions = [item("q1")];
  const typed = setQuestionFreeform(createQuestionStep(questions), questions, "旁注");
  assert.equal(typed.choices[0]?.selectedId, "vite");
  assert.equal(questionChoiceText(questions[0], typed.choices[0]), "Vite");
});

test("skip with custom text submits that text; an empty skip drops the question", () => {
  const questions = [item("q1", { is_other: true }), item("q2")];
  const typed = setQuestionFreeform(createQuestionStep(questions), questions, "Vite plus");
  const kept = skipQuestionStep(typed, questions);
  assert.equal(kept.type, "advance");
  if (kept.type !== "advance") return;
  assert.equal(kept.state.choices[0]?.freeform, "Vite plus");
  assert.deepEqual(skipQuestionStep(kept.state, questions), {
    type: "submit",
    answers: { q1: "Vite plus" },
    skipped: false,
  });
});

test("skipping every blocking question closes as a full skip", () => {
  let state = createQuestionStep(blocking);
  const first = skipQuestionStep(state, blocking);
  assert.equal(first.type, "advance");
  if (first.type !== "advance") return;
  state = first.state;
  const second = skipQuestionStep(state, blocking);
  assert.equal(second.type, "advance");
  if (second.type !== "advance") return;
  assert.deepEqual(skipQuestionStep(second.state, blocking), {
    type: "submit",
    answers: {},
    skipped: true,
  });
});

test("async reply does not preselect and ignores an empty send", () => {
  const state = createQuestionStep(asyncQuestions);
  assert.equal(state.choices[0]?.selectedId, null);
  assert.deepEqual(continueQuestionStep(state, asyncQuestions), { type: "stay", state });
});

test("async skip drops the current draft even when it has text", () => {
  const questions = [
    item("q1", { surface: "async-reply", is_other: true }),
    item("q2", { surface: "async-reply", is_other: true }),
  ];
  const picked = selectQuestionOption(createQuestionStep(questions), questions, "vite");
  assert.equal(picked.type, "advance");
  if (picked.type !== "advance") return;
  const typed = setQuestionFreeform(picked.state, questions, "不要这条");
  assert.deepEqual(skipQuestionStep(typed, questions), {
    type: "submit",
    answers: { q1: "Vite" },
    skipped: false,
  });
});

test("multi-select toggles without advancing and joins the labels", () => {
  const questions = [item("q1", { multi_select: true, is_other: true })];
  const state = createQuestionStep(questions);
  assert.deepEqual(state.choices[0]?.selectedIds, []);
  const first = selectQuestionOption(state, questions, "vite");
  assert.equal(first.type, "advance");
  if (first.type !== "advance") return;
  assert.equal(first.state.index, 0);
  const second = selectQuestionOption(first.state, questions, "next");
  assert.equal(second.type, "advance");
  if (second.type !== "advance") return;
  const off = selectQuestionOption(second.state, questions, "vite");
  assert.equal(off.type, "advance");
  if (off.type !== "advance") return;
  assert.deepEqual(continueQuestionStep(off.state, questions), {
    type: "submit",
    answers: { q1: "Next.js" },
    skipped: false,
  });
});

test("paging clamps and a full dismiss drops local answers", () => {
  const state = createQuestionStep(blocking);
  const next = pageQuestion(state, blocking, 5);
  assert.equal(next.type, "advance");
  if (next.type !== "advance") return;
  assert.equal(next.state.index, 2);
  assert.deepEqual(pageQuestion(next.state, blocking, 2), { type: "stay", state: next.state });
  assert.deepEqual(dismissQuestionStep(), { type: "submit", answers: {}, skipped: true });
});

test("recommended suffix is the 14-character Codex marker", () => {
  assert.equal(RECOMMENDED_LENGTH, 14);
  assert.deepEqual(optionPresentation("Vite (Recommended)"), { label: "Vite", recommended: true });
  assert.deepEqual(optionPresentation("Vite"), { label: "Vite", recommended: false });
});

const RECOMMENDED_LENGTH = " (Recommended)".length;

test("number keys select, arrows page, and escape dismisses", () => {
  assert.deepEqual(
    questionKeyAction({
      key: "2",
      composing: false,
      focus: "card",
      questionCount: 2,
      questionIndex: 0,
      optionCount: 2,
      selectedIndex: 0,
      isOther: true,
      hasOptions: true,
      multi: false,
    }),
    { type: "select", index: 1 },
  );
  assert.deepEqual(
    questionKeyAction({
      key: "3",
      composing: false,
      focus: "card",
      questionCount: 2,
      questionIndex: 0,
      optionCount: 2,
      selectedIndex: 0,
      isOther: true,
      hasOptions: true,
      multi: false,
    }),
    { type: "focus-freeform" },
  );
  assert.deepEqual(
    questionKeyAction({
      key: "ArrowRight",
      composing: false,
      focus: "card",
      questionCount: 3,
      questionIndex: 0,
      optionCount: 2,
      selectedIndex: 0,
      isOther: false,
      hasOptions: true,
      multi: false,
    }),
    { type: "page", index: 1 },
  );
  assert.deepEqual(
    questionKeyAction({
      key: "Enter",
      composing: false,
      focus: "card",
      questionCount: 1,
      questionIndex: 0,
      optionCount: 2,
      selectedIndex: 0,
      isOther: false,
      hasOptions: true,
      multi: true,
    }),
    { type: "submit" },
  );
  assert.deepEqual(
    questionKeyAction({
      key: "Escape",
      composing: false,
      focus: "freeform",
      questionCount: 1,
      questionIndex: 0,
      optionCount: 2,
      selectedIndex: 0,
      isOther: true,
      hasOptions: true,
      multi: false,
    }),
    { type: "dismiss" },
  );
  assert.deepEqual(
    questionKeyAction({
      key: "Enter",
      composing: false,
      focus: "dismiss",
      questionCount: 1,
      questionIndex: 0,
      optionCount: 0,
      selectedIndex: -1,
      isOther: false,
      hasOptions: false,
      multi: false,
    }),
    { type: "none" },
  );
});
