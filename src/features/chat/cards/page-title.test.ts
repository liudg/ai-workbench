import assert from "node:assert/strict";
import { test } from "node:test";

import { pageTitleFromHtml } from "./page-title.ts";

test("website card reads the document title", () => {
  assert.equal(pageTitleFromHtml("<html><title> 虎豹 &amp; 自行车 </title></html>"), "虎豹 & 自行车");
  assert.equal(pageTitleFromHtml("<p>没有标题</p>"), "");
});
