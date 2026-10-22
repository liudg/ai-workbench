import assert from "node:assert/strict";
import { test } from "node:test";

import { isFileHref } from "../../../shared/markdown/file-href.ts";
import {
  fileLineRef,
  isHtmlHref,
  lineFromHref,
  opensLocalHtmlInBrowser,
  previewKindForPath,
  resolvePreviewPath,
} from "./preview-kind.ts";

test("preview resolves project files and files outside the project", () => {
  const root = "C:/work/demo";
  assert.equal(resolvePreviewPath(root, "index.html"), "C:/work/demo/index.html");
  assert.equal(resolvePreviewPath(root, "docs/notes.md"), "C:/work/demo/docs/notes.md");
  assert.equal(resolvePreviewPath(root, "file:///C:/work/demo/readme.txt"), "C:/work/demo/readme.txt");
  assert.equal(resolvePreviewPath(root, "../secret.txt"), "C:/work/secret.txt");
  assert.equal(resolvePreviewPath(root, "C:/work/demo-evil/index.html"), "C:/work/demo-evil/index.html");
  assert.equal(resolvePreviewPath("", "/tmp/notes.md"), "/tmp/notes.md");
  assert.equal(resolvePreviewPath("", "notes.md"), null);
  assert.equal(resolvePreviewPath(root, "https://example.com/a.html"), null);
  assert.equal(previewKindForPath("C:/work/demo/index.html"), "html");
  assert.equal(previewKindForPath("notes.md"), "markdown");
  assert.equal(previewKindForPath("src/app.ts"), "text");
  assert.equal(previewKindForPath("available-live.png"), "image");
  assert.equal(previewKindForPath("Assets/shot.JPEG"), "image");
  assert.equal(previewKindForPath("icon.svg"), "image");
  assert.equal(previewKindForPath("photo.webp"), "image");
  assert.equal(previewKindForPath("scan.bmp"), "image");
  assert.equal(previewKindForPath("anim.gif"), "image");
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
  assert.equal(isHtmlHref("index.html:12"), false);
});

test("path line, column, range, and hash are stripped before the file is resolved", () => {
  const root = "C:/work/demo";
  const file = "C:/work/demo/src/Auth/LoginService.cs";
  for (const href of [
    "src/Auth/LoginService.cs:648",
    "src/Auth/LoginService.cs:648:12",
    "src/Auth/LoginService.cs:648-660",
    "src/Auth/LoginService.cs:648:1-660:4",
    "src/Auth/LoginService.cs#L648",
    "src/Auth/LoginService.cs#L648-L660",
    "src/Auth/LoginService.cs#L648C3",
    "src/Auth/LoginService.cs:648?plain=1",
  ]) {
    assert.equal(resolvePreviewPath(root, href), file, href);
    assert.equal(lineFromHref(href), 648, href);
    assert.equal(isFileHref(href), true, href);
  }
  assert.equal(resolvePreviewPath(root, "C:/outside/Auth/LoginService.cs:648"), "C:/outside/Auth/LoginService.cs");
  assert.equal(lineFromHref("C:/outside/Auth/LoginService.cs:648:9"), 648);
  assert.equal(resolvePreviewPath(root, "C:/work/demo/index.html"), "C:/work/demo/index.html");
  assert.equal(lineFromHref("C:/work/demo/index.html"), null);
  assert.equal(isFileHref("LoginService.cs:648"), true);
  assert.equal(isFileHref("LoginService.cs:648:12"), true);
  assert.equal(isFileHref("https://example.com/LoginService.cs:648"), false);
  assert.equal(isFileHref("note:12"), false);
  assert.deepEqual(fileLineRef("LoginService.cs:648"), { path: "LoginService.cs", line: 648 });
  assert.deepEqual(fileLineRef("src/Auth/LoginService.cs:648:12"), { path: "src/Auth/LoginService.cs", line: 648 });
  assert.equal(fileLineRef("just some words"), null);
});

test("codex angle-bracket windows paths resolve onto the drive", () => {
  const root = "D:/work/demo";
  const expected = "C:/Users/admin/Documents/AI Workbench/2026-10-19/h5-3/snake.html";
  assert.equal(
    resolvePreviewPath(root, "</C:/Users/admin/Documents/AI Workbench/2026-10-19/h5-3/snake.html>"),
    expected,
  );
  assert.equal(
    resolvePreviewPath(root, "/C:/Users/admin/Documents/AI Workbench/2026-10-19/h5-3/snake.html"),
    expected,
  );
  assert.equal(
    resolvePreviewPath(root, "file:///C:/Users/admin/Documents/AI%20Workbench/2026-10-19/h5-3/snake.html"),
    expected,
  );
  assert.equal(
    resolvePreviewPath(root, "file://localhost/C:/Users/admin/Documents/AI Workbench/2026-10-19/h5-3/snake.html"),
    expected,
  );
  assert.equal(resolvePreviewPath(root, "<file:///C:/work/demo/readme.txt>"), "C:/work/demo/readme.txt");
  assert.equal(resolvePreviewPath("", "/tmp/notes.md"), "/tmp/notes.md");
  assert.equal(opensLocalHtmlInBrowser(expected, null), true);
  assert.equal(opensLocalHtmlInBrowser("page.htm", null), true);
  assert.equal(opensLocalHtmlInBrowser(expected, 4), false);
  assert.equal(opensLocalHtmlInBrowser("C:/work/demo/src/app.ts", null), false);
});
