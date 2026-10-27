import assert from "node:assert/strict";
import { test } from "node:test";

import { clearSuccess, visibleFeedback, writeFeedback } from "./feedbackState.ts";

test("an operation notice stays on the agent that started it", () => {
  let book = writeFeedback({}, "codex-cli", null);
  book = writeFeedback(book, "codex-cli", {
    tone: "failure",
    title: "无法禁用",
    detail: "配置无法读取",
  });

  assert.equal(visibleFeedback(book, "cursor-agent"), null);
  assert.equal(visibleFeedback(book, "codex-cli")?.tone, "failure");

  book = writeFeedback(book, "cursor-agent", { tone: "success", text: "已保存" });
  assert.equal(visibleFeedback(book, "cursor-agent")?.tone, "success");
  assert.equal(visibleFeedback(book, "codex-cli")?.tone, "failure");

  book = clearSuccess(book, "cursor-agent");
  assert.equal(visibleFeedback(book, "cursor-agent"), null);
  assert.equal(visibleFeedback(book, "codex-cli")?.tone, "failure");
  assert.equal(clearSuccess(book, "codex-cli"), book);
});
