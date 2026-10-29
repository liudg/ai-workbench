import assert from "node:assert/strict";
import { test } from "node:test";

import { composerKeyIntent, isSendNowChord, stepIndex } from "./composer-keys.ts";

const idle = {
  key: "Enter",
  shiftKey: false,
  composing: false,
  editing: false,
  skillOpen: false,
  hasActiveSkill: false,
  slashOpen: false,
  hasActiveSlash: false,
  mentionOpen: false,
  hasActiveMention: false,
};

test("composer keys pick from an open menu instead of sending", () => {
  assert.equal(stepIndex(0, 3, "ArrowUp"), 2);
  assert.equal(stepIndex(2, 3, "ArrowDown"), 0);
  assert.deepEqual(composerKeyIntent({ ...idle, key: "Escape", editing: true }), { type: "cancel-edit" });
  assert.equal(composerKeyIntent({ ...idle, key: "Escape" }), null);
  const slash = { ...idle, slashOpen: true, hasActiveSlash: true };
  assert.deepEqual(composerKeyIntent(slash), { type: "apply-slash", run: true });
  assert.deepEqual(composerKeyIntent({ ...slash, key: "Tab" }), { type: "apply-slash", run: false });
  assert.deepEqual(composerKeyIntent({ ...slash, key: "Escape" }), { type: "dismiss-popup" });
  assert.deepEqual(composerKeyIntent({ ...slash, key: "ArrowDown" }), { type: "slash-move", key: "ArrowDown" });
  assert.deepEqual(composerKeyIntent({ ...slash, hasActiveSlash: false }), { type: "submit" });
  assert.equal(composerKeyIntent({ ...slash, shiftKey: true }), null);
  const skill = { ...idle, skillOpen: true, hasActiveSkill: true };
  assert.deepEqual(composerKeyIntent(skill), { type: "apply-skill" });
  assert.deepEqual(composerKeyIntent({ ...skill, key: "Tab" }), { type: "apply-skill" });
  assert.deepEqual(composerKeyIntent({ ...skill, key: "Escape" }), { type: "dismiss-popup" });
  assert.deepEqual(composerKeyIntent({ ...skill, hasActiveSkill: false }), { type: "submit" });
  assert.equal(composerKeyIntent({ ...idle, key: "Enter", shiftKey: true }), null);
  assert.equal(composerKeyIntent({ ...idle, composing: true }), null);
  assert.deepEqual(composerKeyIntent(idle), { type: "submit" });
  assert.equal(composerKeyIntent({ ...idle, key: "Escape", editing: true, composing: true }), null);
  assert.equal(composerKeyIntent({ ...idle, keyCode: 229 }), null);
  assert.equal(
    composerKeyIntent({ ...idle, key: "ArrowDown", mentionOpen: true, composing: true }),
    null,
  );
  assert.deepEqual(composerKeyIntent({ ...idle, key: "Escape", mentionOpen: true }), {
    type: "dismiss-mention",
  });
  assert.deepEqual(
    composerKeyIntent({ ...idle, mentionOpen: true, hasActiveMention: true }),
    { type: "apply-mention" },
  );
  assert.deepEqual(
    composerKeyIntent({ ...idle, mentionOpen: true, hasActiveMention: false }),
    { type: "mention-noop" },
  );
  assert.deepEqual(composerKeyIntent({ ...idle, key: "ArrowDown", mentionOpen: true }), {
    type: "mention-move",
    key: "ArrowDown",
  });
});

test("ctrl enter sends now and leaves other chords alone", () => {
  assert.equal(isSendNowChord({ key: "Enter", shiftKey: false, ctrlKey: true }), true);
  assert.equal(isSendNowChord({ key: "Enter", shiftKey: false, metaKey: true }), true);
  assert.equal(isSendNowChord({ key: "Enter", shiftKey: true, ctrlKey: true }), false);
  assert.equal(isSendNowChord({ key: "Enter", shiftKey: false, ctrlKey: true, altKey: true }), false);
  assert.equal(isSendNowChord({ key: "Enter", shiftKey: false, ctrlKey: true, repeat: true }), false);
  assert.equal(isSendNowChord({ key: "k", shiftKey: false, ctrlKey: true }), false);
  assert.equal(isSendNowChord({ key: "b", shiftKey: false, ctrlKey: true }), false);
  assert.equal(isSendNowChord({ key: "p", shiftKey: false, ctrlKey: true }), false);
  assert.equal(isSendNowChord({ key: "f", shiftKey: false, ctrlKey: true }), false);
  assert.deepEqual(composerKeyIntent({ ...idle, ctrlKey: true }), { type: "submit-now" });
  assert.deepEqual(composerKeyIntent({ ...idle, metaKey: true }), { type: "submit-now" });
  assert.equal(composerKeyIntent({ ...idle, ctrlKey: true, shiftKey: true }), null);
  assert.equal(composerKeyIntent({ ...idle, ctrlKey: true, altKey: true }), null);
  assert.deepEqual(composerKeyIntent({ ...idle, altKey: true }), { type: "submit" });
  assert.equal(composerKeyIntent({ ...idle, ctrlKey: true, repeat: true }), null);
  assert.deepEqual(composerKeyIntent({ ...idle, repeat: true }), { type: "submit" });
  assert.equal(composerKeyIntent({ ...idle, ctrlKey: true, composing: true }), null);
  assert.equal(composerKeyIntent({ ...idle, ctrlKey: true, keyCode: 229 }), null);
  assert.equal(composerKeyIntent({ ...idle, key: "k", ctrlKey: true }), null);
  assert.equal(composerKeyIntent({ ...idle, key: "b", ctrlKey: true }), null);
  assert.equal(composerKeyIntent({ ...idle, key: "p", ctrlKey: true }), null);
  assert.equal(composerKeyIntent({ ...idle, key: "f", ctrlKey: true }), null);
  assert.deepEqual(
    composerKeyIntent({
      ...idle,
      ctrlKey: true,
      mentionOpen: true,
      hasActiveMention: true,
    }),
    { type: "submit-now" },
  );
  assert.deepEqual(
    composerKeyIntent({
      ...idle,
      ctrlKey: true,
      slashOpen: true,
      hasActiveSlash: true,
    }),
    { type: "submit-now" },
  );
  assert.deepEqual(
    composerKeyIntent({
      ...idle,
      ctrlKey: true,
      skillOpen: true,
      hasActiveSkill: true,
    }),
    { type: "submit-now" },
  );
});
