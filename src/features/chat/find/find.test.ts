import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";

import { clearThreadMarks, paintThreadHits } from "./highlight.ts";
import { collectTextHits, stepHit } from "./hits.ts";
import { isThreadFindChord } from "./keyboard.ts";

test("thread find chord is Ctrl or Cmd+F without shift", () => {
  const base = { key: "f", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  assert.equal(isThreadFindChord({ ...base, ctrlKey: true }), true);
  assert.equal(isThreadFindChord({ ...base, metaKey: true, key: "F" }), true);
  assert.equal(isThreadFindChord({ ...base, ctrlKey: true, shiftKey: true }), false);
  assert.equal(isThreadFindChord({ ...base, ctrlKey: true, altKey: true }), false);
  assert.equal(isThreadFindChord(base), false);
});

test("hits step wraps and an empty query matches nothing", () => {
  assert.equal(stepHit(0, 3, 1), 1);
  assert.equal(stepHit(2, 3, 1), 0);
  assert.equal(stepHit(0, 3, -1), 2);
  assert.equal(stepHit(0, 0, 1), 0);
});

test("search reads visible timeline text and skips hidden nodes", () => {
  const dom = new Window();
  const root = dom.document.createElement("div");
  root.innerHTML = [
    "<p>装备对比提示</p>",
    "<p>再看一次装备颜色</p>",
    "<div hidden>隐藏的装备</div>",
    "<textarea>输入框里的装备</textarea>",
    "<script>装备</script>",
  ].join("");
  const hits = collectTextHits(root as unknown as Node, "装备");
  assert.deepEqual(
    hits.map((hit) => hit.node.textContent?.slice(hit.start, hit.end)),
    ["装备", "装备"],
  );
  assert.equal(collectTextHits(root as unknown as Node, "  ").length, 0);
  assert.equal(collectTextHits(root as unknown as Node, "EQUIP").length, 0);
  const folded = dom.document.createElement("div");
  folded.innerHTML = "<span>Case</span>";
  assert.equal(collectTextHits(folded as unknown as Node, "case").length, 1);
});

test("marks paint the current hit and clear back to plain text", () => {
  const dom = new Window();
  const root = dom.document.createElement("div");
  root.innerHTML = "<p>装备对比和装备颜色</p>";
  const hits = collectTextHits(root as unknown as Node, "装备");
  paintThreadHits(hits, 1);
  const marks = root.querySelectorAll("mark[data-thread-find-mark]");
  assert.equal(marks.length, 2);
  assert.equal(marks[0]?.getAttribute("data-thread-find-mark"), "hit");
  assert.equal(marks[1]?.getAttribute("data-thread-find-mark"), "current");
  assert.equal(root.textContent, "装备对比和装备颜色");
  clearThreadMarks(root as unknown as ParentNode);
  assert.equal(root.querySelector("mark"), null);
  assert.equal(root.textContent, "装备对比和装备颜色");
});
