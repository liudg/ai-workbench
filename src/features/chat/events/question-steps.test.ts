import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createQuestionStep,
  dismissQuestionStep,
  sendQuestionStep,
  skipQuestionStep,
  type QuestionStepState,
} from "./question-steps.ts";

const questions = [{ id: "q1" }, { id: "q2" }, { id: "q3" }];

function draft(state: QuestionStepState, text: string): QuestionStepState {
  return { ...state, draft: text };
}

test("send on a middle question advances and keeps the answer locally", () => {
  const effect = sendQuestionStep(draft(createQuestionStep(), "  Vite  "), questions);
  assert.deepEqual(effect, {
    type: "advance",
    state: { index: 1, answers: { q1: "Vite" }, draft: "" },
  });
});

test("blank send stays on the current question", () => {
  const state = draft(createQuestionStep(), "   ");
  assert.deepEqual(sendQuestionStep(state, questions), { type: "stay", state });
});

test("send on the last question submits every filled answer and closes", () => {
  const first = sendQuestionStep(draft(createQuestionStep(), "Vite"), questions);
  assert.equal(first.type, "advance");
  if (first.type !== "advance") return;
  const second = sendQuestionStep(draft(first.state, "none"), questions);
  assert.equal(second.type, "advance");
  if (second.type !== "advance") return;
  assert.deepEqual(sendQuestionStep(draft(second.state, "  ship it  "), questions), {
    type: "submit",
    answers: { q1: "Vite", q2: "none", q3: "ship it" },
    skipped: false,
  });
});

test("a single question send submits and closes", () => {
  assert.deepEqual(sendQuestionStep(draft(createQuestionStep(), "Red"), [{ id: "q1" }]), {
    type: "submit",
    answers: { q1: "Red" },
    skipped: false,
  });
});

test("skip drops the current question and continues", () => {
  const first = sendQuestionStep(draft(createQuestionStep(), "Vite"), questions);
  assert.equal(first.type, "advance");
  if (first.type !== "advance") return;
  const skipped = skipQuestionStep(draft(first.state, "ignore me"), questions);
  assert.deepEqual(skipped, {
    type: "advance",
    state: { index: 2, answers: { q1: "Vite" }, draft: "" },
  });
  if (skipped.type !== "advance") return;
  assert.deepEqual(sendQuestionStep(draft(skipped.state, "later"), questions), {
    type: "submit",
    answers: { q1: "Vite", q3: "later" },
    skipped: false,
  });
});

test("skipping the last question still submits earlier answers", () => {
  const first = sendQuestionStep(draft(createQuestionStep(), "Vite"), [
    { id: "q1" },
    { id: "q2" },
  ]);
  assert.equal(first.type, "advance");
  if (first.type !== "advance") return;
  assert.deepEqual(skipQuestionStep(draft(first.state, "unused"), [{ id: "q1" }, { id: "q2" }]), {
    type: "submit",
    answers: { q1: "Vite" },
    skipped: false,
  });
});

test("skipping the only question closes as a full skip", () => {
  assert.deepEqual(skipQuestionStep(draft(createQuestionStep(), "Red"), [{ id: "q1" }]), {
    type: "submit",
    answers: {},
    skipped: true,
  });
});

test("skipping every question closes as a full skip", () => {
  let state = createQuestionStep();
  const first = skipQuestionStep(state, questions);
  assert.equal(first.type, "advance");
  if (first.type !== "advance") return;
  state = first.state;
  const second = skipQuestionStep(state, questions);
  assert.equal(second.type, "advance");
  if (second.type !== "advance") return;
  assert.deepEqual(skipQuestionStep(second.state, questions), {
    type: "submit",
    answers: {},
    skipped: true,
  });
});

test("dismiss closes the whole prompt as skipped", () => {
  assert.deepEqual(dismissQuestionStep(), { type: "submit", answers: {}, skipped: true });
});
