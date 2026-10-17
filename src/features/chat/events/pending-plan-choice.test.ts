import assert from "node:assert/strict";
import { test } from "node:test";

import type { PromptOption, SessionEvent, SessionEventBody } from "../../../types/index.ts";
import { isPinnedChoice, pendingPlanChoice } from "./pending-plan-choice.ts";

function event(id: string, body: SessionEventBody): SessionEvent {
  return { id, session_id: "s", seq: 1, ts: 1, ...body };
}

function option(id: string, label: string, slot?: string, disabled?: string): PromptOption {
  return { id, label, description: "说明", slot, disabled_reason: disabled };
}

function plan(id: string): SessionEvent {
  return event(id, {
    kind: "prompt",
    prompt_id: id,
    prompt_kind: "choice",
    question: "实施此计划？",
    options: [
      option("implement", "是，实施此计划", "primary"),
      option("clear-context", "是，清空上下文并实施", "leading"),
      option("stay", "否，留在计划模式", "deny"),
    ],
    questions: [],
  });
}

test("a slotted choice after a finished plan is the panel", () => {
  const found = pendingPlanChoice(
    [
      event("u", { kind: "user-message", text: "做一个贪吃蛇" }),
      event("a", { kind: "agent-message", text: "计划正文", phase: "final-answer" }),
      event("s", { kind: "status-changed", status: "completed" }),
      plan("implement-plan-1"),
    ],
    "completed",
  );
  assert.equal(found?.prompt_id, "implement-plan-1");
  assert.equal(found ? isPinnedChoice(found) : false, true);
});

test("a resolved plan choice and a plain choice stay off the panel", () => {
  assert.equal(
    pendingPlanChoice(
      [plan("p1"), event("r", { kind: "prompt-resolved", prompt_id: "p1", answer: "否，留在计划模式" })],
      "completed",
    ),
    null,
  );
  const plain = event("access", {
    kind: "prompt",
    prompt_id: "local-access",
    prompt_kind: "choice",
    question: "权限",
    options: [option("ask", "询问批准")],
    questions: [],
  });
  assert.equal(isPinnedChoice(plain), false);
  assert.equal(pendingPlanChoice([plain], "completed"), null);
});

test("a newer question or a stopped session hides the plan panel", () => {
  const hidden = pendingPlanChoice(
    [
      plan("p1"),
      event("q", {
        kind: "prompt",
        prompt_id: "q",
        prompt_kind: "questions",
        question: "选哪个？",
        options: [],
        questions: [{ id: "q1", question: "选哪个？", is_secret: false, options: [] }],
      }),
    ],
    "completed",
  );
  assert.equal(hidden, null);
  assert.equal(pendingPlanChoice([plan("p1")], "stopped"), null);
  assert.equal(pendingPlanChoice([plan("p1")], "failed"), null);
});
