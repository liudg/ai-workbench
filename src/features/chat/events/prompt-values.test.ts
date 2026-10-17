import assert from "node:assert/strict";
import { test } from "node:test";

import type { PromptQuestion } from "../../../types/index.ts";
import {
  compactBlock,
  elicitationContent,
  filledQuestionAnswers,
  optionResolvedLabel,
  settledAnswerLine,
} from "./prompt-values.ts";

const question = (patch: Partial<PromptQuestion>): PromptQuestion => ({
  id: "q",
  question: "",
  is_secret: false,
  options: [],
  ...patch,
});

test("question card drops blank answers", () => {
  assert.deepEqual(filledQuestionAnswers({ a: "  甲  ", b: "  ", c: "乙" }), { a: "甲", c: "乙" });
  assert.deepEqual(filledQuestionAnswers({ a: " " }), {});
});

test("settled answer drops trailing blank lines and stays on one line", () => {
  assert.equal(compactBlock("贪吃蛇想怎么玩？\n\n"), "贪吃蛇想怎么玩？");
  assert.equal(compactBlock("第一行\n第二行"), "第一行\n第二行");
  assert.equal(settledAnswerLine("浏览器页面\n\n"), "已回答：浏览器页面");
  assert.equal(settledAnswerLine("1. 浏览器页面\r\n2. 键盘\n"), "已回答：1. 浏览器页面\n2. 键盘");
  assert.equal(settledAnswerLine(" \n "), null);
  assert.equal(settledAnswerLine(null), null);
});

test("resolved option label falls back to the raw answer", () => {
  assert.equal(optionResolvedLabel([{ id: "approve", label: "允许" }], "approve"), "允许");
  assert.equal(optionResolvedLabel([{ id: "approve", label: "允许" }], "自己写的"), "自己写的");
  assert.equal(optionResolvedLabel([], null), null);
});

test("elicitation keeps types and refuses a missing required field", () => {
  const fields = [
    question({ id: "name", required: true }),
    question({ id: "count", input_kind: "integer" }),
    question({ id: "ratio", input_kind: "number" }),
    question({ id: "ok", input_kind: "boolean" }),
    question({ id: "note" }),
  ];
  assert.deepEqual(
    elicitationContent(fields, { name: " a ", count: "3", ratio: "1.5" }, { ok: true }),
    { ok: true, content: { name: "a", count: 3, ratio: 1.5, ok: true } },
  );
  assert.deepEqual(elicitationContent(fields, { count: "3" }, {}), { ok: false });
  assert.deepEqual(
    elicitationContent([question({ id: "count", input_kind: "integer" })], { count: "nope" }, {}),
    { ok: true, content: { count: "nope" } },
  );
});
