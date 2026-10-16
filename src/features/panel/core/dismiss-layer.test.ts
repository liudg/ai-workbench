import assert from "node:assert/strict";
import { test } from "node:test";

import { dismissLayerCount, dismissTop, pushDismissLayer } from "./dismiss-layer.ts";

test("escape closes only the top layer", () => {
  const closed: string[] = [];
  const removeA = pushDismissLayer(() => closed.push("a"));
  const removeB = pushDismissLayer(() => closed.push("b"));
  assert.equal(dismissLayerCount(), 2);
  assert.equal(dismissTop(), true);
  assert.deepEqual(closed, ["b"]);
  removeB();
  assert.equal(dismissTop(), true);
  assert.deepEqual(closed, ["b", "a"]);
  removeA();
  assert.equal(dismissTop(), false);
  assert.equal(dismissLayerCount(), 0);
});
