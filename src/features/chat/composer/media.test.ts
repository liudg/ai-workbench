import assert from "node:assert/strict";
import { test } from "node:test";

import { fileName, isImagePath } from "./media.ts";

test("image paths accept pictures and reject other files", () => {
  assert.equal(isImagePath("C:\\shots\\a.PNG"), true);
  assert.equal(isImagePath("/tmp/a.jpeg"), true);
  assert.equal(isImagePath("data:image/png;base64,aaaa"), true);
  assert.equal(isImagePath("https://example.com/a.webp"), true);
  assert.equal(isImagePath("notes.txt"), false);
  assert.equal(isImagePath("https://example.com/file.pdf"), false);
  assert.equal(isImagePath(""), false);
  assert.equal(fileName("C:\\shots\\a.PNG"), "a.PNG");
  assert.equal(fileName("data:image/png;base64,aaaa"), "图片");
});
