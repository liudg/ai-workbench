import assert from "node:assert/strict";
import { test } from "node:test";

import {
  userBubbleModel,
  userImageLayout,
  userShowsTextBubble,
  userTextBubbleClass,
} from "./user-image-layout.ts";

test("a single attachment is its own preview layer, not the text bubble", () => {
  const model = userBubbleModel("添加装备，然后弹出截图中的界面", 1);
  assert.equal(model.showTextBubble, true);
  assert.match(model.textBubbleClass, /wb-user-bubble/);
  assert.match(model.textBubbleClass, /rounded-full/);
  assert.ok(model.images);
  assert.equal(model.images.columns, 1);
  assert.equal(model.images.maxEdgePx, 320);
  assert.equal(model.images.frameMaxPx, 320);
  assert.match(model.images.frameClassName, /max-w-\[min\(100%,320px\)\]/);
  assert.match(model.images.thumbClassName, /max-h-64/);
  assert.match(model.images.thumbClassName, /object-contain/);
  assert.doesNotMatch(model.images.frameClassName, /wb-user-bubble|rounded-full/);
  assert.doesNotMatch(model.images.thumbClassName, /wb-user-bubble|rounded-full/);
});

test("several images shrink and wrap instead of growing the preview", () => {
  const one = userImageLayout(1);
  const two = userImageLayout(2);
  const three = userImageLayout(3);
  const four = userImageLayout(4);
  const six = userImageLayout(6);
  assert.ok(one && two && three && four && six);

  assert.deepEqual(
    [one.maxEdgePx, two.maxEdgePx, three.maxEdgePx, six.maxEdgePx],
    [320, 160, 112, 80],
  );
  assert.equal(four.maxEdgePx, three.maxEdgePx);
  assert.ok(six.maxEdgePx < four.maxEdgePx);

  for (const layout of [two, three, four, six]) {
    assert.equal(layout.frameMaxPx, layout.columns * layout.maxEdgePx + (layout.columns - 1) * 6);
    assert.match(layout.frameClassName, /flex-wrap/);
    assert.match(layout.frameClassName, new RegExp(`${layout.frameMaxPx}px`));
    assert.match(layout.thumbClassName, new RegExp(`${layout.maxEdgePx}px`));
    assert.doesNotMatch(`${layout.frameClassName} ${layout.thumbClassName}`, /wb-user-bubble|rounded-full/);
  }

  assert.equal(two.columns, 2);
  assert.equal(three.columns, 3);
  assert.equal(four.columns, 2);
  assert.equal(six.columns, 3);

  const nine = userImageLayout(9);
  assert.ok(nine);
  assert.equal(nine.columns, six.columns);
  assert.equal(nine.maxEdgePx, six.maxEdgePx);
  assert.equal(nine.frameMaxPx, six.frameMaxPx);
});

test("image-only and text-only messages keep the matching layer", () => {
  const imagesOnly = userBubbleModel("  ", 3);
  assert.equal(imagesOnly.showTextBubble, false);
  assert.equal(imagesOnly.images?.columns, 3);

  const textOnly = userBubbleModel("你好", 0);
  assert.equal(textOnly.images, null);
  assert.equal(textOnly.showTextBubble, true);
  assert.match(textOnly.textBubbleClass, /rounded-full/);

  const multiline = userBubbleModel(`第一行\n第二行`, 2);
  assert.equal(multiline.showTextBubble, true);
  assert.match(multiline.textBubbleClass, /rounded-2xl/);
  assert.doesNotMatch(multiline.textBubbleClass, /rounded-full/);

  assert.equal(userImageLayout(0), null);
  assert.equal(userImageLayout(-2), null);
  assert.equal(userShowsTextBubble("", 0), true);
  assert.match(userTextBubbleClass("看".repeat(47)), /rounded-full/);
  assert.match(userTextBubbleClass("看".repeat(48)), /rounded-2xl/);
});
