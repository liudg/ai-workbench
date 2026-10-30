import assert from "node:assert/strict";
import { test } from "node:test";

import {
  atToken,
  caretAfterMentionPick,
  clearAtToken,
  mentionPickText,
  highlightParts,
  mentionAddItems,
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

test("mention pick keeps the cleared text until a newer draft arrives", () => {
  assert.equal(mentionPickText("看 @bao", "看 @bao", "看 "), "看 ");
  assert.equal(mentionPickText("看 @bao", "看 后面", "看 "), "看 后面");
});

test("mention pick uses the caret left after the file dialog", () => {
  assert.equal(caretAfterMentionPick(4, 7, 12), 7);
  assert.equal(caretAfterMentionPick(4, null, 12), 4);
  assert.equal(caretAfterMentionPick(4, 40, 12), 12);
  assert.equal(caretAfterMentionPick(4, -2, 12), 0);
});

test("paths with spaces are quoted and the @ query can be cleared", () => {
  assert.equal(quoteMentionPath("Assets/a.png"), "Assets/a.png");
  assert.equal(quoteMentionPath("My Files/a.png"), '"My Files/a.png"');
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

test("unsupported goal and plan are left out of the add menu", () => {
  assert.deepEqual(mentionAddItems("ready", "ready"), ["files", "goal", "plan"]);
  assert.deepEqual(mentionAddItems("unsupported", "ready"), ["files", "plan"]);
  assert.deepEqual(mentionAddItems("unsupported", "unsupported"), ["files"]);
  assert.deepEqual(mentionAddItems("loading", "loading"), ["files", "goal", "plan"]);
});
