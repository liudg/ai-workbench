import assert from "node:assert/strict";
import test from "node:test";

import {
  commentedDraft,
  createTextSnippet,
  mergeSnippetText,
  textSnippetBadge,
  textSnippetPreview,
  withTextSnippet,
  withoutTextSnippet,
  type TextSnippet,
} from "./text-snippet.ts";

function snippet(id: string, body: string, quote = `\`\`\`a.cs\n${body}\n\`\`\``): TextSnippet {
  const created = createTextSnippet(
    { path: "a.cs", body, start: 1, end: 1, quote },
    id,
  );
  if (!created) throw new Error("snippet");
  return created;
}

test("add and remove keep snippet order and ignore duplicate ids", () => {
  const first = snippet("a", "one");
  const second = snippet("b", "two");
  const added = withTextSnippet(withTextSnippet([], first), second);
  assert.deepEqual(added.map((item) => item.id), ["a", "b"]);
  assert.equal(withTextSnippet(added, first).length, 2);
  assert.deepEqual(withoutTextSnippet(added, "a").map((item) => item.id), ["b"]);
  assert.equal(withoutTextSnippet(added, "missing"), added);
});

test("blank selections are not stored", () => {
  assert.equal(
    createTextSnippet({ path: "a.cs", body: "  \n", start: 1, end: 1, quote: "```a.cs\n```" }),
    null,
  );
  assert.equal(
    createTextSnippet({ path: " ", body: "line", start: null, end: null, quote: "```a.cs\nline\n```" }),
    null,
  );
  const kept = snippet("a", "one");
  const list = [kept];
  assert.equal(withTextSnippet(list, { ...kept, id: " ", quote: " ", body: " " }), list);
});

test("submit merge keeps the user's words and drops a removed snippet", () => {
  const first = snippet("a", "one", "```a.cs\none\n```");
  const second = snippet("b", "two", "```a.cs\ntwo\n```");
  assert.equal(mergeSnippetText("", [first, second]), "```a.cs\none\n```\n\n```a.cs\ntwo\n```");
  assert.equal(
    mergeSnippetText("先看这个", [first, second]),
    "先看这个\n\n```a.cs\none\n```\n\n```a.cs\ntwo\n```",
  );
  assert.equal(mergeSnippetText("先看这个", withoutTextSnippet([first, second], "a")), "先看这个\n\n```a.cs\ntwo\n```");
  assert.equal(mergeSnippetText("先看这个", []), "先看这个");
  assert.equal(mergeSnippetText("", []), "");
});

test("card badge and preview stay short", () => {
  assert.equal(textSnippetBadge({ path: "src/a.cs", start: 3, end: 3 }), "a.cs:3");
  assert.equal(textSnippetBadge({ path: "src/a.cs", start: 3, end: 5 }), "a.cs:3-5");
  assert.equal(textSnippetBadge({ path: "src/a.cs", start: null, end: null }), "a.cs");
  assert.equal(textSnippetBadge({ path: "对话", start: null, end: null }), "摘录");
  assert.equal(textSnippetBadge({ path: "src/a.cs", start: 3, end: 3, note: "why" }), "评论");
  assert.equal(textSnippetPreview("one\ntwo"), "one\ntwo");
  assert.equal(textSnippetPreview("1\n2\n3\n4\n5"), "1\n2\n3\n4...");
});

test("a comment rides after the quote and is kept for display", () => {
  const draft = commentedDraft({ path: "a.cs", body: "one", start: 3, end: 3, quote: "```3:3:a.cs\none\n```" }, "  rename this  ");
  assert.equal(draft?.quote, "```3:3:a.cs\none\n```\n评论：rename this");
  assert.equal(createTextSnippet(draft!, "c")?.note, "rename this");
  assert.equal(commentedDraft({ path: "a.cs", body: "one", start: 3, end: 3, quote: "q" }, "   "), null);
});
