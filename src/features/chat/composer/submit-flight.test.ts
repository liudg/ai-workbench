import assert from "node:assert/strict";
import { test } from "node:test";

import {
  claimSubmit,
  releaseSubmitOnEdit,
  settleSubmit,
  shouldClearSubmittedText,
  submitFingerprint,
} from "./submit-flight.ts";

test("the same draft cannot be submitted twice until it changes", () => {
  const fingerprint = submitFingerprint({
    editingId: null,
    text: "你好",
    fileCount: 0,
    snippetCount: 0,
  });
  const next = { sessionId: "s", fingerprint };
  const flight = claimSubmit(null, next);
  assert.equal(flight.claimed, true);
  assert.equal(claimSubmit(flight.flight, next).claimed, false);
  const released = releaseSubmitOnEdit(
    flight.flight,
    "s",
    submitFingerprint({
      editingId: null,
      text: "",
      fileCount: 0,
      snippetCount: 0,
    }),
  );
  assert.equal(released, null);
  assert.equal(claimSubmit(released, { sessionId: "s", fingerprint: "next" }).claimed, true);
});

test("an older submit does not clear a newer flight", () => {
  const newer = { sessionId: "s", fingerprint: "b" };
  assert.deepEqual(settleSubmit(newer, "s", "a"), newer);
  assert.equal(settleSubmit(newer, "s", "b"), null);
  assert.deepEqual(settleSubmit(newer, "other", "b"), newer);
});

test("a send does not wipe text typed while it was in flight", () => {
  assert.equal(shouldClearSubmittedText("你好", "你好"), true);
  assert.equal(shouldClearSubmittedText("你好！", "你好"), false);
  assert.equal(shouldClearSubmittedText(null, "你好"), true);
});
