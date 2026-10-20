import assert from "node:assert/strict";
import { test } from "node:test";

import { composerCtrlEnter, queueFlushIds, submitDelivery } from "./composer-now.ts";

const idle = {
  text: "",
  fileCount: 0,
  snippetCount: 0,
  queueCount: 0,
  editing: false,
  pendingQuestion: false,
  composerLocked: false,
};

test("ctrl enter sends composer content immediately", () => {
  assert.deepEqual(composerCtrlEnter({ ...idle, text: "接着改" }), { type: "submit-now" });
  assert.deepEqual(composerCtrlEnter({ ...idle, text: "  接着改  " }), { type: "submit-now" });
  assert.deepEqual(composerCtrlEnter({ ...idle, fileCount: 1 }), { type: "submit-now" });
  assert.deepEqual(composerCtrlEnter({ ...idle, snippetCount: 2 }), { type: "submit-now" });
  assert.deepEqual(composerCtrlEnter({ ...idle, text: "改一下", editing: true, queueCount: 3 }), {
    type: "submit-now",
  });
});

test("ctrl enter flushes the queue only when the composer is empty", () => {
  assert.deepEqual(composerCtrlEnter({ ...idle, queueCount: 2 }), { type: "flush-queue" });
  assert.deepEqual(composerCtrlEnter({ ...idle, text: "   ", queueCount: 1 }), { type: "flush-queue" });
  assert.deepEqual(composerCtrlEnter(idle), { type: "noop" });
  assert.deepEqual(composerCtrlEnter({ ...idle, editing: true, queueCount: 2 }), { type: "noop" });
  assert.deepEqual(composerCtrlEnter({ ...idle, composerLocked: true, text: "在跑" }), { type: "noop" });
  assert.deepEqual(composerCtrlEnter({ ...idle, composerLocked: true, queueCount: 2 }), { type: "noop" });
});

test("ctrl enter leaves a pending question on the normal answer path", () => {
  assert.deepEqual(
    composerCtrlEnter({ ...idle, pendingQuestion: true, text: "用第二个", queueCount: 2 }),
    { type: "plain-submit" },
  );
  assert.deepEqual(
    composerCtrlEnter({ ...idle, pendingQuestion: true, queueCount: 2 }),
    { type: "noop" },
  );
  assert.deepEqual(
    composerCtrlEnter({ ...idle, pendingQuestion: true, snippetCount: 1 }),
    { type: "noop" },
  );
});

test("queue flush keeps order and does not merge rows", () => {
  assert.deepEqual(queueFlushIds(["q1", "q2", "q3"]), ["q1", "q2", "q3"]);
  assert.deepEqual(queueFlushIds(["q2", "", "q1", "q2"]), ["q2", "q1"]);
  assert.deepEqual(queueFlushIds([]), []);
});

test("ctrl enter delivery skips the queue and keeps drafts on the normal send", () => {
  assert.equal(
    submitDelivery({ now: true, holdUntilAccepted: false, decision: "send-text" }),
    "send-now",
  );
  assert.equal(
    submitDelivery({ now: true, holdUntilAccepted: false, decision: "send-images" }),
    "send-now",
  );
  assert.equal(
    submitDelivery({ now: true, holdUntilAccepted: false, decision: "plan-message" }),
    "send-now",
  );
  assert.equal(
    submitDelivery({ now: true, holdUntilAccepted: true, decision: "plan-message" }),
    "send",
  );
  assert.equal(
    submitDelivery({ now: true, holdUntilAccepted: true, decision: "send-text" }),
    "send",
  );
  assert.equal(
    submitDelivery({ now: true, holdUntilAccepted: false, decision: "update-queue" }),
    "send-now",
  );
  assert.equal(
    submitDelivery({ now: false, holdUntilAccepted: false, decision: "update-queue" }),
    "queue-edit",
  );
  assert.equal(
    submitDelivery({ now: false, holdUntilAccepted: false, decision: "send-text" }),
    "send",
  );
  assert.equal(submitDelivery({ now: true, holdUntilAccepted: false, decision: "answer" }), "other");
  assert.equal(submitDelivery({ now: true, holdUntilAccepted: false, decision: "set-goal" }), "other");
  assert.equal(
    submitDelivery({ now: true, holdUntilAccepted: false, decision: "toggle-plan" }),
    "other",
  );
  assert.equal(
    submitDelivery({ now: true, holdUntilAccepted: false, decision: "open-review" }),
    "other",
  );
});
