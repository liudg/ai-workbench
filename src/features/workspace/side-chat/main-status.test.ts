import assert from "node:assert/strict";
import { test } from "node:test";

import { mainStatusNote, SIDE_COPY } from "./main-status.ts";

test("only changes after the side chat opened are reported", () => {
  assert.equal(mainStatusNote("completed", false), null);
  assert.equal(mainStatusNote("running", true), null);
  assert.equal(mainStatusNote("completed", true), SIDE_COPY.mainFinished);
  assert.equal(mainStatusNote("failed", true), SIDE_COPY.mainFailed);
  assert.equal(mainStatusNote("stopped", true), SIDE_COPY.mainStopped);
});

test("a main thread waiting on you is always reported", () => {
  assert.equal(mainStatusNote("needs-input", false), SIDE_COPY.mainNeedsInput);
});
