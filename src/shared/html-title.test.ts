import assert from "node:assert/strict";
import { test } from "node:test";

import { pageTitleFromHtml } from "./html-title.ts";

test("page title comes from the title element", () => {
  assert.equal(
    pageTitleFromHtml("<html><head><title>虎豹自行车</title></head><body></body></html>"),
    "虎豹自行车",
  );
  assert.equal(pageTitleFromHtml("<html><title> 虎豹 &amp; 自行车 </title></html>"), "虎豹 & 自行车");
  assert.equal(pageTitleFromHtml("<p>没有标题</p>"), "");
  assert.equal(pageTitleFromHtml("<title>A &amp; B</title>"), "A & B");
});
