import assert from "node:assert/strict";
import { test } from "node:test";

import { fileLineRef, isHtmlHref, lineFromHref, previewKindForPath, resolvePreviewPath } from "./preview-kind.ts";

test("preview links stay inside the project", () => {
  const root = "C:/work/demo";
  assert.equal(resolvePreviewPath(root, "index.html"), "C:/work/demo/index.html");
  assert.equal(resolvePreviewPath(root, "docs/notes.md"), "C:/work/demo/docs/notes.md");
  assert.equal(resolvePreviewPath(root, "file:///C:/work/demo/readme.txt"), "C:/work/demo/readme.txt");
  assert.equal(resolvePreviewPath(root, "../secret.txt"), null);
  assert.equal(resolvePreviewPath(root, "C:/work/demo-evil/index.html"), null);
  assert.equal(resolvePreviewPath(root, "https://example.com/a.html"), null);
  assert.equal(previewKindForPath("C:/work/demo/index.html"), "html");
  assert.equal(previewKindForPath("notes.md"), "markdown");
  assert.equal(previewKindForPath("src/app.ts"), "text");
});

test("line references and html links parse without inventing a scheme", () => {
  assert.deepEqual(fileLineRef("annotate.html (line 12)"), { path: "annotate.html", line: 12 });
  assert.equal(fileLineRef("annotate.html"), null);
  assert.equal(fileLineRef("note (line 0)"), null);
  assert.equal(lineFromHref("src/app.ts#L2"), 2);
  assert.equal(lineFromHref("src/app.ts"), null);
  assert.equal(isHtmlHref("index.html"), true);
  assert.equal(isHtmlHref("https://example.com/a.html?q=1"), true);
  assert.equal(isHtmlHref("notes.md"), false);
});
