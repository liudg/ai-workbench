import assert from "node:assert/strict";
import { test } from "node:test";

import { diffFileDisclosureClass } from "./diff-disclosure.ts";

test("diff file disclosure uses the observed rotate classes", () => {
  assert.equal(diffFileDisclosureClass(false), "rotate-0");
  assert.equal(diffFileDisclosureClass(true), "rotate-90");
});
