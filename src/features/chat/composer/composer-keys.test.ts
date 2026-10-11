import assert from "node:assert/strict";
import { test } from "node:test";

import { composerKeyIntent, stepIndex } from "./composer-keys.ts";

const idle = {
  key: "Enter",
  shiftKey: false,
  composing: false,
  editing: false,
  skillOpen: false,
  hasActiveSkill: false,
  slashOpen: false,
  hasActiveSlash: false,
  token: null as string | null,
  text: "你好",
  skillQuery: null as string | null,
};

test("composer keys complete a slash or skill before sending", () => {
  assert.equal(stepIndex(0, 3, "ArrowUp"), 2);
  assert.equal(stepIndex(2, 3, "ArrowDown"), 0);
  assert.deepEqual(composerKeyIntent({ ...idle, key: "Escape", editing: true }), { type: "cancel-edit" });
  assert.equal(composerKeyIntent({ ...idle, key: "Escape" }), null);
  assert.deepEqual(
    composerKeyIntent({
      ...idle,
      slashOpen: true,
      hasActiveSlash: true,
      token: "/re",
      activeSlashName: "/review",
      text: "/re",
    }),
    { type: "apply-slash" },
  );
  assert.deepEqual(
    composerKeyIntent({
      ...idle,
      slashOpen: true,
      hasActiveSlash: true,
      token: "/review",
      activeSlashName: "/review",
      text: "/review now",
    }),
    { type: "submit" },
  );
  assert.deepEqual(
    composerKeyIntent({
      ...idle,
      skillOpen: true,
      hasActiveSkill: true,
      skillQuery: "re",
      activeSkillMention: "review",
      text: "$re",
    }),
    { type: "apply-skill" },
  );
  assert.equal(composerKeyIntent({ ...idle, key: "Enter", shiftKey: true }), null);
  assert.equal(composerKeyIntent({ ...idle, composing: true }), null);
});
