import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldSubmitRename } from "./rename-submit.ts";

test("enter submits a non-empty rename title", () => {
  assert.equal(
    shouldSubmitRename({ key: "Enter", composing: false, keyCode: 13, title: "qa-session" }),
    true,
  );
  assert.equal(
    shouldSubmitRename({ key: "Enter", title: "  有标题  " }),
    true,
  );
});

test("empty title and non-enter keys do not submit", () => {
  assert.equal(shouldSubmitRename({ key: "Enter", title: "" }), false);
  assert.equal(shouldSubmitRename({ key: "Enter", title: "   " }), false);
  assert.equal(shouldSubmitRename({ key: "Escape", title: "qa-session" }), false);
  assert.equal(shouldSubmitRename({ key: "a", title: "qa-session" }), false);
});

test("ime composition enter does not submit", () => {
  assert.equal(
    shouldSubmitRename({ key: "Enter", composing: true, keyCode: 13, title: "qa-session" }),
    false,
  );
  assert.equal(
    shouldSubmitRename({ key: "Enter", composing: false, keyCode: 229, title: "qa-session" }),
    false,
  );
});
