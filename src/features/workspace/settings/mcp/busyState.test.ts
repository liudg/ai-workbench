import assert from "node:assert/strict";
import { test } from "node:test";

import { beginForm, beginRow, busyNames, emptyBusy, endForm, endRow, formBusy } from "./busyState.ts";

test("an older row finish does not clear a newer operation", () => {
  let book = beginRow(emptyBusy(), "alpha", 1);
  book = beginRow(book, "beta", 2);
  book = beginRow(book, "alpha", 3);
  book = endRow(book, "alpha", 1);
  assert.deepEqual(busyNames(book).sort(), ["alpha", "beta"]);
  book = endRow(book, "alpha", 3);
  assert.deepEqual(busyNames(book), ["beta"]);
  assert.equal(endRow(book, "missing", 2), book);
});

test("an older save finish does not clear the form", () => {
  let book = beginForm(emptyBusy(), 1);
  book = beginForm(book, 2);
  assert.equal(formBusy(endForm(book, 1)), true);
  assert.equal(formBusy(endForm(book, 2)), false);
  assert.deepEqual(endRow(emptyBusy(), "alpha", 1), emptyBusy());
});
