import assert from "node:assert/strict";
import { test } from "node:test";

import {
  atToken,
  clearAtToken,
  highlightParts,
  insertMention,
  mentionFiles,
  mentionSupport,
  quoteMentionPath,
} from "./mentions.ts";

test("at token is the query after @ and is empty when just typed", () => {
  assert.equal(atToken("@", 1), "");
  const typed = "看 @baoshi";
  assert.equal(atToken(typed, typed.length), "baoshi");
  assert.equal(atToken("user@host", "user@host".length), null);
  const later = "已写 @baoshi 之后";
  assert.equal(atToken(later, later.length), null);
});

test("file mention replaces the token and quotes paths with spaces", () => {
  assert.equal(quoteMentionPath("Assets/a.png"), "Assets/a.png");
  assert.equal(quoteMentionPath("My Files/a.png"), '"My Files/a.png"');
  const inserted = insertMention("看 @bao", 6, ["Assets/AB/icon.png"]);
  assert.equal(inserted.text, "看 Assets/AB/icon.png ");
  assert.equal(inserted.caret, inserted.text.length);
  const spaced = insertMention("@q", 2, ["My Files/a.png"]);
  assert.equal(spaced.text, '"My Files/a.png" ');
  assert.deepEqual(clearAtToken("看 @bao", 6), { text: "看 ", caret: 2 });
});

test("mention results prefer the filename hit and keep the directory", () => {
  const rows = mentionFiles(
    ["notes/baoshi.txt", "Assets/AB/icon_baoshi_lv.png", "src/other.ts"],
    "baoshi",
  );
  assert.equal(rows[0]?.name, "baoshi.txt");
  assert.equal(rows[0]?.directory, "notes");
  assert.equal(rows[1]?.name, "icon_baoshi_lv.png");
  assert.equal(rows[1]?.directory, "Assets/AB");
  assert.deepEqual(highlightParts("icon_baoshi_lv.png", "baoshi").filter((part) => part.match), [
    { text: "baoshi", match: true },
  ]);
});

test("goal and plan stay disabled until capabilities are known", () => {
  assert.equal(mentionSupport(false, false), "loading");
  assert.equal(mentionSupport(true, false), "unsupported");
  assert.equal(mentionSupport(true, true), "ready");
});
