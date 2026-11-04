import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEvent } from "../../../types/index.ts";
import { offerState } from "./subtask-offer.ts";

type OfferEvent = Extract<SessionEvent, { kind: "subtask-offer" }>;

function offer(extra: Partial<OfferEvent> = {}): OfferEvent {
  return {
    id: "e",
    session_id: "s",
    seq: 1,
    ts: 1_000,
    kind: "subtask-offer",
    offer_id: "o",
    initiation: "own_initiative",
    subtasks: [{ agent: "codex-cli", title: "修登录", prompt: "修" }],
    ...extra,
  };
}

test("a card expires only when it carries an expiry", () => {
  assert.equal(offerState(offer({ expires_at: 5_000 }), 4_000), "pending");
  assert.equal(offerState(offer({ expires_at: 5_000 }), 6_000), "expired");
  assert.equal(offerState(offer({ initiation: "offer" }), Number.MAX_SAFE_INTEGER), "pending");
});

test("a chosen card shows the choice", () => {
  assert.equal(offerState(offer({ resolution: { kind: "accepted", task_ids: ["t"] } }), 0), "accepted");
  assert.equal(offerState(offer({ expires_at: 1, resolution: { kind: "declined" } }), 9), "declined");
});
