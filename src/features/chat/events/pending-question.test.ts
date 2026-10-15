import assert from "node:assert/strict";
import { test } from "node:test";

import type { PromptQuestion, SessionEvent, SessionEventBody } from "../../../types/index.ts";
import { pendingQuestionEvent } from "./pending-question.ts";

function event(id: string, body: SessionEventBody): SessionEvent {
  return { id, session_id: "s", seq: 1, ts: 1, ...body };
}

function question(id: string, text: string): PromptQuestion {
  return { id, question: text, is_secret: false, options: [] };
}

function ask(id: string, questions: PromptQuestion[]): SessionEvent {
  return event(id, {
    kind: "prompt",
    prompt_id: id,
    prompt_kind: "questions",
    question: questions[0]?.question ?? "",
    options: [],
    questions,
  });
}

test("pending question is the latest unresolved questions prompt", () => {
  const first = ask("p1", [question("q1", "第一题")]);
  const second = ask("p2", [question("q2", "第二题"), question("q3", "第三题")]);
  const found = pendingQuestionEvent(
    [first, event("r", { kind: "prompt-resolved", prompt_id: "p1", answer: "已答" }), second],
    "needs-input",
  );
  assert.equal(found?.prompt_id, "p2");
});

test("a newer unresolved approval hides an older question", () => {
  const found = pendingQuestionEvent(
    [
      ask("p1", [question("q1", "第一题")]),
      event("a", {
        kind: "prompt",
        prompt_id: "a",
        prompt_kind: "approval",
        question: "允许？",
        options: [],
        questions: [],
      }),
    ],
    "running",
  );
  assert.equal(found, null);
});

test("stopped and failed sessions do not float a question", () => {
  const events = [ask("p1", [question("q1", "第一题")])];
  assert.equal(pendingQuestionEvent(events, "stopped"), null);
  assert.equal(pendingQuestionEvent(events, "failed"), null);
});

test("a resolved question does not float", () => {
  const found = pendingQuestionEvent(
    [
      ask("p1", [question("q1", "第一题")]),
      event("r", { kind: "prompt-resolved", prompt_id: "p1", answer: "1. 甲" }),
    ],
    "needs-input",
  );
  assert.equal(found, null);
});
