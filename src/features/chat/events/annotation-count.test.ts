import assert from "node:assert/strict";
import { test } from "node:test";

import { annotationCountLabel, annotationCountOf } from "./annotation-count.ts";

test("annotation chip matches Codex one/other copy", () => {
  assert.equal(annotationCountOf(0), null);
  assert.equal(annotationCountOf(undefined), null);
  assert.deepEqual(annotationCountOf(2), { count: 2 });
  assert.equal(annotationCountLabel(1), "1 条注释");
  assert.equal(annotationCountLabel(2), "2 条注释");
});
