import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseQuestionReply,
  questionReplyStartsCollapsed,
  questionReplyTitle,
} from "./question-reply.ts";

function display(rows: readonly (readonly [string, string])[]): string {
  return rows.map(([question, answer]) => `> ${question}\n\n${answer}`).join("\n\n");
}

function envelope(rows: readonly (readonly [string, string])[]): string {
  const body = JSON.stringify(
    rows.map(([question, answer], index) => ({
      answer,
      question,
      questionItemId: `q${index}`,
    })),
  );
  return `<send_user_message_question_reply>\n${body}\n</send_user_message_question_reply>`;
}

test("display text keeps each question and answer", () => {
  assert.deepEqual(parseQuestionReply(display([["用哪个框架？", "Vite"]])), [
    { question: "用哪个框架？", answer: "Vite" },
  ]);
  assert.deepEqual(
    parseQuestionReply(
      display([
        ["用哪个框架？", "Vite"],
        ["还有限制吗？", "先别加依赖"],
      ]),
    ),
    [
      { question: "用哪个框架？", answer: "Vite" },
      { question: "还有限制吗？", answer: "先别加依赖" },
    ],
  );
});

test("answers can keep their own line breaks", () => {
  assert.deepEqual(parseQuestionReply(display([["怎么改？", "第一行\n第二行"]])), [
    { question: "怎么改？", answer: "第一行\n第二行" },
  ]);
});

test("the reply envelope and a single object decode to the same rows", () => {
  const rows = [
    ["Which framework? Pick one", "Vite"],
    ["Constraints?", "none"],
  ] as const;
  assert.deepEqual(parseQuestionReply(envelope(rows)), [
    { question: "Which framework? Pick one", answer: "Vite" },
    { question: "Constraints?", answer: "none" },
  ]);
  const one = `<send_user_message_question_reply>{"answer":"Vite","question":"Which framework?","questionItemId":"q"}</send_user_message_question_reply>`;
  assert.deepEqual(parseQuestionReply(one), [{ question: "Which framework?", answer: "Vite" }]);
});

test("several envelopes joined by blank lines stay one reply", () => {
  const text = `${envelope([["第一题", "甲"]])}\n\n${envelope([["第二题", "乙"]])}`;
  assert.deepEqual(parseQuestionReply(text), [
    { question: "第一题", answer: "甲" },
    { question: "第二题", answer: "乙" },
  ]);
});

test("an ide preamble still unwraps the envelope", () => {
  const text = `# Context from my IDE setup:\nworkspace\n## My request for Codex:\n${envelope([["用哪个？", "Vite"]])}`;
  assert.deepEqual(parseQuestionReply(text), [{ question: "用哪个？", answer: "Vite" }]);
});

test("ordinary user text is not a question reply", () => {
  assert.equal(parseQuestionReply("帮我看一下这个接口"), null);
  assert.equal(parseQuestionReply("甲，乙"), null);
  assert.equal(parseQuestionReply("1. Vite\n2. 无"), null);
  assert.equal(parseQuestionReply("> 只是一行引用"), null);
  assert.equal(parseQuestionReply("> 第一行\n> 第二行\n\n正文"), null);
  assert.equal(parseQuestionReply("前面还有话\n\n> 问题\n\n答案"), null);
});

test("three or more replies start collapsed", () => {
  assert.equal(questionReplyStartsCollapsed(1), false);
  assert.equal(questionReplyStartsCollapsed(2), false);
  assert.equal(questionReplyStartsCollapsed(3), true);
  assert.equal(questionReplyStartsCollapsed(5), true);
  assert.equal(questionReplyTitle(5), "已回答 5 题");
});
