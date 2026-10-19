import assert from "node:assert/strict";
import { test } from "node:test";

import { createTextSnippet, mergeSnippetText } from "../../../shared/text-snippet.ts";

import { chatSelectionDraft } from "./chat-selection.ts";

test("a chat selection becomes a quote the composer can send", () => {
  const draft = chatSelectionDraft("结论：先不收。\n还要再看。\n");
  assert.ok(draft);
  assert.equal(draft.path, "对话");
  assert.equal(draft.body, "结论：先不收。\n还要再看。");
  assert.equal(draft.start, null);
  assert.equal(draft.end, null);
  assert.equal(draft.quote, "> 结论：先不收。\n> 还要再看。");
  assert.equal(draft.quote.includes("```"), false);
  const snippet = createTextSnippet(draft);
  assert.ok(snippet);
  assert.equal(mergeSnippetText("看这段", [snippet]), "看这段\n\n> 结论：先不收。\n> 还要再看。");
});

test("blank chat selections are dropped", () => {
  assert.equal(chatSelectionDraft("   \n"), null);
  assert.equal(chatSelectionDraft(""), null);
});
