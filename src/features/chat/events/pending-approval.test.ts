import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent, SessionEventBody } from "../../../types/index.ts";
import { approvalSlots, pendingApprovalEvent } from "./pending-approval.ts";

function event(id: string, body: SessionEventBody): SessionEvent {
  return { id, session_id: "s", seq: 1, ts: 1, ...body };
}

function approval(id: string, question: string): SessionEvent {
  return event(id, {
    kind: "prompt",
    prompt_id: id,
    prompt_kind: "approval",
    question,
    options: [
      { id: "accept", label: "允许一次", slot: "primary" },
      { id: "decline", label: "拒绝", slot: "deny" },
    ],
    questions: [],
  });
}

test("the newest unresolved approval is the one card", () => {
  const found = pendingApprovalEvent(
    [
      approval("old", "第一条"),
      event("r", { kind: "prompt-resolved", prompt_id: "old", answer: "accept" }),
      approval("new", "第二条"),
    ],
    "needs-input",
  );
  assert.equal(found?.prompt_id, "new");
});

test("a newer question keeps the approval queued", () => {
  const found = pendingApprovalEvent(
    [
      approval("a", "命令"),
      event("q", {
        kind: "prompt",
        prompt_id: "q",
        prompt_kind: "questions",
        question: "选哪个？",
        options: [],
        questions: [{ id: "q1", question: "选哪个？", is_secret: false, options: [] }],
      }),
    ],
    "running",
  );
  assert.equal(found, null);
});

test("stopped sessions do not show an approval", () => {
  assert.equal(pendingApprovalEvent([approval("a", "命令")], "stopped"), null);
});

test("slots come from the adapter, including the scoped action", () => {
  const slots = approvalSlots([
    { id: "applyNetworkPolicyAmendment", label: "始终允许", slot: "leading" },
    { id: "accept", label: "允许一次", slot: "primary" },
    { id: "decline", label: "拒绝", slot: "deny" },
    { id: "acceptForSession", label: "允许此对话", slot: "scoped" },
  ]);
  assert.equal(slots.leading?.label, "始终允许");
  assert.equal(slots.primary?.id, "accept");
  assert.equal(slots.deny?.id, "decline");
  assert.equal(slots.scoped?.label, "允许此对话");
});
