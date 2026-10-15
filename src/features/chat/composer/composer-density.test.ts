import assert from "node:assert/strict";
import { test } from "node:test";

import { composerDensity } from "./composer-density.ts";

test("composer controls step from labels to icons as the bar narrows", () => {
  assert.equal(composerDensity(0), "compact");
  assert.equal(composerDensity(640), "full");
  assert.equal(composerDensity(420), "full");
  assert.equal(composerDensity(419), "compact");
  assert.equal(composerDensity(360), "compact");
  assert.equal(composerDensity(359), "icons");
  assert.equal(composerDensity(200), "icons");
});
