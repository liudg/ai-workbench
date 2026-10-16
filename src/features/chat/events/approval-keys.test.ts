import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approvalKeyAction,
  releaseApproval,
  releaseOwnedApproval,
  takeApproval,
  type ApprovalGate,
} from "./approval-keys.ts";

const idle = {
  key: "Enter",
  composing: false,
  keyCode: 13,
  defaultPrevented: false,
  inDialog: false,
  onButton: false,
  inField: false,
};

test("approval keys ignore ime, handled escape, and the composer field", () => {
  assert.equal(approvalKeyAction(idle), "approve");
  assert.equal(approvalKeyAction({ ...idle, key: "Escape" }), "deny");
  assert.equal(approvalKeyAction({ ...idle, key: "Escape", defaultPrevented: true }), "none");
  assert.equal(approvalKeyAction({ ...idle, key: "Escape", composing: true }), "none");
  assert.equal(approvalKeyAction({ ...idle, keyCode: 229 }), "none");
  assert.equal(approvalKeyAction({ ...idle, inField: true }), "none");
  assert.equal(approvalKeyAction({ ...idle, key: "Escape", inField: true }), "deny");
  assert.equal(approvalKeyAction({ ...idle, inDialog: true, key: "Escape" }), "none");
  assert.equal(approvalKeyAction({ ...idle, onButton: true }), "none");
});

test("an approval can only be sent once until it is released", () => {
  const gate: ApprovalGate = { busy: false };
  assert.equal(takeApproval(gate), true);
  assert.equal(takeApproval(gate), false);
  releaseApproval(gate);
  assert.equal(takeApproval(gate), true);
});

test("a failed approval does not unlock the prompt that replaced it", () => {
  const first: ApprovalGate = { busy: false };
  const next: ApprovalGate = { busy: false };
  assert.equal(takeApproval(first), true);
  assert.equal(takeApproval(next), true);
  assert.equal(releaseOwnedApproval(next, first), false);
  assert.equal(next.busy, true);
  assert.equal(first.busy, true);
  assert.equal(releaseOwnedApproval(next, next), true);
  assert.equal(next.busy, false);
});
