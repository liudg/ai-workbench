import assert from "node:assert/strict";
import { test } from "node:test";

import type { PageAnnotation } from "@/types";
import { annotationCountLabel, annotationLabel, foldPageAnnotations, tabTitleFromDocument } from "./annotate.ts";

const note = (patch: Partial<PageAnnotation>): PageAnnotation => ({
  id: "1",
  url: "",
  selector: "",
  text: "",
  comment: "",
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  kind: "element",
  ...patch,
});

test("tab title is document.title and keeps the page's own number", () => {
  assert.equal(tabTitleFromDocument("虎豹自行车 92"), "虎豹自行车 92");
  assert.equal(tabTitleFromDocument("  虎豹自行车  "), "虎豹自行车");
  assert.equal(tabTitleFromDocument("虎豹自行车"), "虎豹自行车");
});

test("annotation count chip matches Codex", () => {
  assert.equal(annotationCountLabel(1), "1 条注释");
  assert.equal(annotationCountLabel(2), "2 条注释");
});

test("annotation chip uses region, text, then selector", () => {
  assert.equal(annotationLabel(note({ kind: "region", text: "ignored" })), "区域");
  assert.equal(annotationLabel(note({ text: "车架" })), "车架");
  assert.equal(annotationLabel(note({ selector: "#bike" })), "#bike");
  assert.equal(annotationLabel(note({})), "元素");
});

test("folded annotation matches the adapter turn text", () => {
  const folded = foldPageAnnotations("看这里", [
    note({
      url: "https://example.com/bike",
      selector: "#bike",
      text: "虎豹",
      comment: "改成红色",
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      screenshot: "C:/shot.png",
    }),
  ]);
  assert.match(folded.text, /^看这里\n\n页面批注 1\n/);
  assert.match(folded.text, /评论：改成红色/);
  assert.match(folded.text, /页面：https:\/\/example.com\/bike/);
  assert.match(folded.text, /选择器：#bike/);
  assert.match(folded.text, /元素文本：虎豹/);
  assert.match(folded.text, /区域：10,20 30×40/);
  assert.match(folded.text, /附图为该区域所在页面的截图。/);
  assert.deepEqual(folded.images, ["C:/shot.png"]);
});
