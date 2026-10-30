import assert from "node:assert/strict";
import { test } from "node:test";

import { composerTokens, expandFileRefs, insertFileRefs, liveFileRefs, refLabel } from "./file-refs.ts";

test("a picked file shows as its name and sends as its full path", () => {
  const inserted = insertFileRefs("看 @bao", 6, ["Assets/AB/icon.png"], []);
  assert.equal(inserted.text, "看 @icon.png ");
  assert.equal(inserted.caret, inserted.text.length);
  assert.deepEqual(inserted.refs, [{ label: "@icon.png", path: "Assets/AB/icon.png" }]);
  assert.equal(expandFileRefs(`${inserted.text}改一下。`, inserted.refs), "看 Assets/AB/icon.png 改一下。");
});

test("same file name in two folders keeps enough of the folder to tell them apart", () => {
  const first = { label: "@index.ts", path: "src/a/index.ts" };
  assert.equal(refLabel("src/b/index.ts", [first]), "@b/index.ts");
  assert.equal(refLabel("src/a/index.ts", [first]), "@index.ts");
  assert.equal(refLabel("C:\\Work\\My Notes\\a b.md", []), '@"a b.md"');
});

test("paths with spaces are quoted when sent", () => {
  const inserted = insertFileRefs("@q", 2, ["My Files/a b.png"], []);
  assert.equal(inserted.text, '@"a b.png" ');
  assert.equal(expandFileRefs(inserted.text, inserted.refs), '"My Files/a b.png" ');
});

test("only whole labels count, and deleted ones drop out", () => {
  const refs = [{ label: "@a.ts", path: "src/a.ts" }];
  assert.equal(expandFileRefs("x@a.ts @a.tsx @a.ts。", refs), "x@a.ts @a.tsx src/a.ts。");
  assert.deepEqual(liveFileRefs("什么也没有", refs), []);
  assert.deepEqual(liveFileRefs("看 @a.ts", refs), refs);
});

test("tokens mark known skills and file refs, the rest stays text", () => {
  const tokens = composerTokens("用 $pdf 读 @a.ts 和 $nope", [{ label: "@a.ts", path: "src/a.ts" }], ["pdf"]);
  assert.deepEqual(tokens, [
    { kind: "text", text: "用 " },
    { kind: "skill", text: "$pdf" },
    { kind: "text", text: " 读 " },
    { kind: "file", text: "@a.ts", path: "src/a.ts" },
    { kind: "text", text: " 和 $nope" },
  ]);
  assert.equal(tokens.map((token) => token.text).join(""), "用 $pdf 读 @a.ts 和 $nope");
});
